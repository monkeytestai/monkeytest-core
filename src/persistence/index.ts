/**
 * On-disk persistence for plans and runs.
 *
 * The CLI and any host that wants to drive the bug-finding loop need a
 * stable, versioned JSON format on disk. Defining the schema here (rather
 * than letting every consumer roll their own) means:
 *
 *   - `monkeytest run`, `monkeytest rerun`, `monkeytest diff` all agree on
 *     the file layout.
 *   - Future schema migrations are explicit (`schema: 1` -> `schema: 2`).
 *   - SaaS hosts can serialise/deserialise the engine's outputs with the
 *     same helpers.
 *
 * On-disk layout (the `.monkeytest/` convention):
 *
 *   .monkeytest/
 *   ├── plan.json                 ← latest plan, tracked-friendly
 *   ├── runs/
 *   │   ├── <ISO-date>.json       ← one stored run per file
 *   │   └── …
 *   └── shots/                    ← screenshots + videos
 *       ├── page-*.png
 *       ├── flow-*-step-*-*.png
 *       └── flow-*.webm
 *
 * Plan files are tiny (a few KB) and well-suited to git. Run files contain
 * absolute paths to evidence under `shots/`; consumers should treat those
 * paths as opaque (or rebase to relative on read).
 *
 * Schema stays at 1. Action traces (`flow.trace`, `bug.trace`),
 * `fingerprintV2`, and `fingerprintParts` are optional, so run files written
 * by older engines still load. `fingerprint` remains the legacy v1 hash.
 * Older bugs have no trace, so `verify` reports them `blocked`.
 */

import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import type { TestPlan, RunResult } from '../types.js';

/** Bumped only on backwards-incompatible changes. */
export const PLAN_FILE_SCHEMA = 1;
export const RUN_FILE_SCHEMA  = 1;

export interface StoredPlan {
  /** `plan.<schema>` for forwards-compat sniffing. */
  schema: typeof PLAN_FILE_SCHEMA;
  /** ISO timestamp the plan was generated. */
  createdAt: string;
  /** Engine version that produced this plan, when known. */
  engine?: string;
  /** Free-form label users can attach (`"smoke"`, `"checkout-only"`, …). */
  label?: string;
  /** The plan itself. */
  plan: TestPlan;
}

export interface StoredRun {
  schema: typeof RUN_FILE_SCHEMA;
  /** ISO timestamp the run started. */
  createdAt: string;
  /** Engine version. */
  engine?: string;
  /** Stable id for cross-referencing (filename basename, no extension). */
  id: string;
  /** Optional reference to the StoredPlan that produced this run. */
  planRef?: { path?: string; createdAt?: string };
  /** The run result. */
  run: RunResult;
}

/**
 * Write a plan to disk. Returns the absolute path written.
 */
export function savePlan(
  plan: TestPlan,
  opts: { dir?: string; filename?: string; label?: string; engine?: string } = {}
): string {

  const dir = resolve(opts.dir || '.monkeytest');
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, opts.filename || 'plan.json');

  const stored: StoredPlan = {
    schema: PLAN_FILE_SCHEMA,
    createdAt: new Date().toISOString(),
    engine: opts.engine,
    label: opts.label,
    plan,
  };

  writeFileSync(file, JSON.stringify(stored, null, 2));
  return file;

}

/**
 * Load a plan from disk. Accepts either:
 *   - a file path (e.g. `.monkeytest/plan.json`), or
 *   - a directory path that contains `plan.json`.
 *
 * Throws on missing file, schema mismatch, or invalid JSON. Forward-compat
 * sniffs the `schema` field so future migrations have a clear upgrade path.
 */
export function loadPlan(pathOrDir: string): StoredPlan {

  const file = pathOrDir.endsWith('.json')
    ? resolve(pathOrDir)
    : resolve(pathOrDir, 'plan.json');

  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not read plan from ${file}: ${msg}`);
  }

  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (err) {
    throw new Error(`${file} is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }

  const obj = parsed as Partial<StoredPlan>;
  if (typeof obj.schema !== 'number' || obj.schema > PLAN_FILE_SCHEMA){
    throw new Error(
      `${file} has plan schema ${obj.schema}; this engine understands up to ${PLAN_FILE_SCHEMA}. `
      + `Upgrade @monkeytestai/monkeytester or regenerate the plan.`
    );
  }
  if (!obj.plan || !Array.isArray(obj.plan.flows)){
    throw new Error(`${file} does not contain a valid TestPlan (missing plan.flows).`);
  }

  return obj as StoredPlan;

}

/**
 * Write a run result to disk under `<dir>/runs/<id>.json`. Returns the
 * absolute path written.
 *
 * The file id defaults to a sortable ISO-like timestamp so directory
 * listings show runs in chronological order.
 */
export function saveRun(
  run: RunResult,
  opts: { dir?: string; id?: string; planRef?: StoredRun['planRef']; engine?: string } = {}
): { path: string; id: string } {

  const baseDir = resolve(opts.dir || '.monkeytest');
  const runsDir = resolve(baseDir, 'runs');
  mkdirSync(runsDir, { recursive: true });

  const id = opts.id || isoStamp();
  const file = resolve(runsDir, `${id}.json`);

  const stored: StoredRun = {
    schema: RUN_FILE_SCHEMA,
    createdAt: new Date().toISOString(),
    engine: opts.engine,
    id,
    planRef: opts.planRef,
    run,
  };

  writeFileSync(file, JSON.stringify(stored, null, 2));
  return { path: file, id };

}

/**
 * Load a stored run from disk. Accepts either:
 *   - a full path to a run JSON (`.monkeytest/runs/2026-05-02T08-12-00.json`),
 *   - a directory containing `runs/<id>.json` plus an `id`,
 *   - or just an id ("latest" returns the most recent file in `.monkeytest/runs/`).
 */
export function loadRun(pathOrIdOrDir: string, opts: { dir?: string } = {}): StoredRun {

  const baseDir = resolve(opts.dir || '.monkeytest');

  let file: string;
  if (pathOrIdOrDir === 'latest'){
    file = latestRunPath(baseDir);
  } else if (pathOrIdOrDir.endsWith('.json')){
    file = resolve(pathOrIdOrDir);
  } else {
    // Treat as id under <baseDir>/runs/
    const candidate = resolve(baseDir, 'runs', `${pathOrIdOrDir}.json`);
    file = candidate;
  }

  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(
      `Could not read run from ${file}: ${err instanceof Error ? err.message : err}\n`
      + `Hint: list available runs with \`ls ${dirname(file)}\``
    );
  }

  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (err) {
    throw new Error(`${file} is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }

  const obj = parsed as Partial<StoredRun>;
  if (typeof obj.schema !== 'number' || obj.schema > RUN_FILE_SCHEMA){
    throw new Error(
      `${file} has run schema ${obj.schema}; this engine understands up to ${RUN_FILE_SCHEMA}.`
    );
  }
  if (!obj.run || !Array.isArray(obj.run.flows)){
    throw new Error(`${file} does not contain a valid RunResult.`);
  }

  return obj as StoredRun;

}

/**
 * List stored runs in a `.monkeytest/runs/` directory, newest-first.
 * Returns just the basenames (without `.json`) so they're easy to feed
 * back into `loadRun` or `monkeytest diff`.
 */
export function listRuns(dir: string = '.monkeytest'): string[] {
  const runsDir = resolve(dir, 'runs');
  let entries: string[];
  try { entries = readdirSync(runsDir); }
  catch { return []; }
  return entries
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''))
    .sort()
    .reverse();
}

/* ── Helpers ──────────────────────────────────────────────────────────── */

function latestRunPath(baseDir: string): string {
  const ids = listRuns(baseDir);
  if (ids.length === 0){
    throw new Error(`No runs found under ${join(baseDir, 'runs')}. Run \`monkeytest run <url>\` first.`);
  }
  return resolve(baseDir, 'runs', `${ids[0]}.json`);
}

/** ISO-8601 stamp that's filesystem-safe (no `:`). */
function isoStamp(): string {
  return new Date().toISOString().replace(/:/g, '-').replace(/\..+$/, 'Z');
}

/* ── Re-exports for convenience ───────────────────────────────────────── */

export { basename };
