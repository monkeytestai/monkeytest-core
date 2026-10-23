/**
 * Layer 2: one real-model run against the demo fixture.
 *
 * The workflow passes GEMINI_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY
 * and selects the provider with LIVE_PROVIDER / LIVE_MODEL / LIVE_SECRET_NAME.
 * Rerun and verify strip every provider key. A missing key during replay
 * fails the process, which is the proof those commands made no LLM call.
 *
 * Exit 1 from `monkeytest run` and `rerun` means blocking bugs were found.
 * Exit 0 from the buggy run means the model missed the fixture.
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startDemoServer } from '../test/fixtures/demo-app/server.ts';

const SEEDED = new Set(['page-error', 'http-4xx', 'http-5xx', 'element-disabled']);
const MIN_SEEDED = 2;
const DIR = 'e2e-artifacts';
const LOG = join(DIR, 'live-e2e.log');
const SECRET_NAMES = [
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'MISTRAL_API_KEY',
  'GROQ_API_KEY',
  'OPENAI_COMPATIBLE_BASE_URL',
  'OPENAI_COMPATIBLE_API_KEY',
];

function log(line: string): void {
  appendFileSync(LOG, `${line}\n`);
  console.log(line);
}

function stripSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  for (const name of SECRET_NAMES) delete next[name];
  return next;
}

function monkey(args: string[], env: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
  log(`$ node dist/cli.js ${args.join(' ')}`);
  const result = spawnSync(process.execPath, ['dist/cli.js', ...args], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
    timeout: 12 * 60 * 1000,
  });
  if (result.stdout) appendFileSync(LOG, result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
  if (result.stderr) appendFileSync(LOG, result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
  return result;
}

function statusOf(result: SpawnSyncReturns<string>, command: string): number {
  if (result.error) throw new Error(`${command} failed to start: ${result.error.message}`);
  if (result.status === null) throw new Error(`${command} was killed (${result.signal || 'no status'})`);
  return result.status;
}

function latestRunId(): string {
  const files = readdirSync(join(DIR, 'runs')).filter(name => name.endsWith('.json')).sort();
  const file = files[files.length - 1];
  if (!file) throw new Error(`no run JSON under ${DIR}/runs`);
  const stored = JSON.parse(readFileSync(join(DIR, 'runs', file), 'utf8')) as { id?: string };
  if (!stored.id) throw new Error('saved run has no id');
  return stored.id;
}

interface StoredBug {
  fingerprint?: string;
  fingerprintParts?: { errorSignal?: string };
}

function readRun(id: string): { bugs: StoredBug[] } {
  const stored = JSON.parse(readFileSync(join(DIR, 'runs', `${id}.json`), 'utf8')) as {
    run?: { bugs?: StoredBug[] };
  };
  return { bugs: stored.run?.bugs ?? [] };
}

function parseVerify(stdout: string): {
  exitCode?: number;
  stats?: { still_broken?: number; flaky?: number };
  results?: Array<{ fingerprint?: string; verdict?: string }>;
} {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`verify did not print JSON:\n${stdout.slice(0, 500)}`);
  return JSON.parse(stdout.slice(start, end + 1));
}

async function main(): Promise<void> {
  if (!existsSync('dist/cli.js')) {
    throw new Error('dist/cli.js is missing. Run npm run build before the live check.');
  }
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const provider = process.env.LIVE_PROVIDER || 'gemini';
  const model = process.env.LIVE_MODEL || 'gemini-flash-lite-latest';
  const secretName = process.env.LIVE_SECRET_NAME || 'GEMINI_API_KEY';
  if (!process.env[secretName]) {
    throw new Error(`${secretName} is empty; refusing to start a live run`);
  }

  const demo = await startDemoServer({ mode: 'buggy' });
  log(`fixture ${demo.getMode()} ${demo.url} provider=${provider} model=${model}`);
  try {
    const run = monkey([
      'run', demo.url,
      '--provider', provider,
      '--model', model,
      '--max', '3',
      '--flows', '4',
      '--dir', DIR,
      '--json',
    ], process.env);
    const runStatus = statusOf(run, 'run');
    if (runStatus === 0) throw new Error('run exited 0; expected blocking bugs (exit 1)');
    if (runStatus !== 1) throw new Error(`run exited ${runStatus}`);

    const runId = latestRunId();
    const bugs = readRun(runId).bugs;
    const seeded = bugs.filter(bug => SEEDED.has(bug.fingerprintParts?.errorSignal || ''));
    const seededFingerprints = new Set(seeded.map(bug => bug.fingerprint || ''));
    log(`run ${runId} exit ${runStatus} bugs=${bugs.length} seeded=${seeded.map(bug => bug.fingerprintParts?.errorSignal).join(',')}`);
    if (seeded.length < MIN_SEEDED) {
      const seen = bugs.map(bug => bug.fingerprintParts?.errorSignal || '(none)').join(', ');
      throw new Error(`expected at least ${MIN_SEEDED} seeded bugs, found ${seeded.length} (signals: ${seen || 'none'})`);
    }

    const stripped = stripSecrets(process.env);
    const replay = monkey(['rerun', runId, '--dir', DIR, '--json'], stripped);
    const replayStatus = statusOf(replay, 'rerun');
    log(`rerun exit ${replayStatus}`);
    if (replayStatus >= 2) {
      throw new Error(`rerun exited ${replayStatus}; replay must not call the LLM`);
    }
    if (replayStatus !== 1) {
      throw new Error(`rerun exited ${replayStatus}; expected 1 while the fixture is still buggy`);
    }

    const broken = monkey(['verify', runId, '--dir', DIR, '--json'], stripped);
    const brokenStatus = statusOf(broken, 'verify');
    const brokenReport = parseVerify(broken.stdout || '');
    log(`verify buggy exit ${brokenStatus} still_broken=${brokenReport.stats?.still_broken ?? 0}`);
    if (brokenStatus !== 1 || (brokenReport.stats?.still_broken ?? 0) < 1) {
      throw new Error(`buggy verify expected exit 1 and a still_broken bug, got exit ${brokenStatus}`);
    }

    const flipped = await fetch(`${demo.url}/__monkeytest/mode`, { method: 'POST', body: 'fixed' });
    if (flipped.status !== 204 || demo.getMode() !== 'fixed') {
      throw new Error('failed to switch the fixture to the fixed variant');
    }

    const fixed = monkey(['verify', runId, '--dir', DIR, '--json'], stripped);
    const fixedStatus = statusOf(fixed, 'verify');
    const fixedReport = parseVerify(fixed.stdout || '');
    const lingering = (fixedReport.results || []).filter(result =>
      result.verdict === 'still_broken' || result.verdict === 'flaky');
    const seededVerdicts = (fixedReport.results || []).filter(result => seededFingerprints.has(result.fingerprint || ''));
    const unfixed = seededVerdicts.filter(result => result.verdict !== 'fixed');
    log(`verify fixed exit ${fixedStatus} lingering=${lingering.length} seededFixed=${seededVerdicts.length - unfixed.length}/${seededFingerprints.size}`);
    if (
      fixedStatus !== 0
      || lingering.length > 0
      || unfixed.length > 0
      || seededVerdicts.length < seededFingerprints.size
    ) {
      throw new Error(`fixed verify expected exit 0, every seeded bug fixed, and no still_broken or flaky bugs; got exit ${fixedStatus}`);
    }
    log('live e2e passed');
  } finally {
    await demo.close();
  }
}

main().catch(err => {
  const message = err instanceof Error ? err.message : String(err);
  try { log(`FAILED ${message}`); } catch { console.error(message); }
  process.exit(1);
});
