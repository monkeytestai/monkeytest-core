#!/usr/bin/env node
/**
 * monkeytest CLI — the bug-finding loop on the command line.
 *
 * Subcommands:
 *
 *   monkeytest init              Scaffold a .monkeytest/ directory.
 *   monkeytest explore <url>     Crawl + plan only. Writes plan.json.
 *   monkeytest run <url>         Full pipeline: explore + plan + run + triage.
 *                                Writes plan.json + runs/<id>.json + shots/.
 *   monkeytest rerun [<runId>]   Replay the recorded action trace (no LLM).
 *                                --heal re-resolves a step whose locator missed.
 *   monkeytest verify [run]      Replay each bug trace and report fixed /
 *                                still_broken / flaky / healed / blocked.
 *   monkeytest diff <a> <b>      Diff two stored runs by bug fingerprint.
 *                                "<a>" / "<b>" are run ids or "latest"/"prev".
 *   monkeytest report [<runId>]  Pretty-print a stored run (flows, bugs, paths).
 *
 * Common flags:
 *   --dir <path>          Working directory (default ./.monkeytest)
 *   --provider <id>       openai | gemini | anthropic | mistral | groq | openai_compatible
 *   --model <id>          Override model id (provider-specific)
 *   --quality <preset>    cheap | balanced | smart  (used by autoLLMConfig)
 *   --max <n>             Max pages to crawl (explore/run only, default 8)
 *   --flows <n>           Max flows to plan (explore/run only, default 6)
 *   --no-headless         Show the browser window
 *   --label <text>        Free-form label saved on the plan/run
 *   --heal                Re-resolve a trace step when its locator misses
 *   --repeat <n>          Replay each bug n times during `verify` (default 1)
 *   --bug <fingerprint>   Verify a single bug
 *   --json                Machine-readable output (run/diff/report/verify)
 *   --fail-on-5xx         Fail a step that saw a same-origin HTTP ≥500 (default)
 *   --no-fail-on-5xx      Leave those responses as evidence on a passed step
 *
 * Exit codes:
 *   0  success / no blocking bugs / no bug still firing
 *   1  blocking bugs (`run` / `rerun`), new or regressed bugs (`diff`),
 *      or any `still_broken` / `flaky` verdict (`verify`)
 *   2  invalid args / setup error
 *   3  engine / runtime error
 */

import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { Monkey } from './monkey.js';
import { createLLM, type LLM } from './llm/index.js';
import { autoLLMConfig, detectProviderFromEnv, CHEAP_FAST_MODEL } from './llm/presets.js';
import {
  savePlan, loadPlan, saveRun, loadRun, listRuns,
  type StoredRun,
} from './persistence/index.js';
import { bugMatchesFingerprint, diffRuns, summariseDiff } from './diff/index.js';
import { replayTraces } from './runner/replay.js';
import { triage } from './triager/index.js';
import { verifyBugs, type VerifyReport } from './verify/index.js';
import type {
  LLMProvider, LLMConfig, MonkeyLLMConfig, BugReport, FlowTrace, RunResult,
} from './types.js';

/* ── Tiny ANSI helpers (no chalk dep) ─────────────────────────────────── */

const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  blue:   '\x1b[34m',
  magenta:'\x1b[35m',
  cyan:   '\x1b[36m',
};

function tty(s: string, code: keyof typeof c): string {
  return process.stdout.isTTY ? `${c[code]}${s}${c.reset}` : s;
}

const ENGINE_VERSION = 'monkeytest-core@0.3';

/* ── Arg parsing ──────────────────────────────────────────────────────── */

interface CommonOpts {
  dir: string;
  provider?: LLMProvider;
  model?: string;
  quality: 'cheap' | 'balanced' | 'smart';
  maxPages: number;
  maxFlows: number;
  headless: boolean;
  label?: string;
  json: boolean;
  apiKey?: string;
  baseURL?: string;
  /** Re-resolve a recorded step when every stored locator misses. */
  heal: boolean;
  /** How many times `verify` replays each bug. */
  repeat: number;
  /** Restrict `verify` to one fingerprint. */
  bug?: string;
  /**
   * Promote a same-origin HTTP ≥500 observed during a step into a blocking
   * bug. Default true. `--no-fail-on-5xx` turns it off.
   */
  failOn5xx: boolean;
}

function defaultCommonOpts(): CommonOpts {
  return {
    dir: '.monkeytest',
    quality: 'balanced',
    maxPages: 8,
    maxFlows: 6,
    headless: true,
    json: false,
    heal: false,
    repeat: 1,
    failOn5xx: true,
  };
}

interface Parsed {
  command: string;
  positional: string[];
  opts: CommonOpts;
  showHelp: boolean;
}

function parseArgs(argv: string[]): Parsed {
  const [, , rawCmd, ...rest] = argv;

  // Treat top-level `--help`/`-h`/`--version`/`-v` as commands, not flags.
  let cmd = rawCmd || 'help';
  if (cmd === '-h' || cmd === '--help') cmd = 'help';
  if (cmd === '-v' || cmd === '--version') cmd = 'version';

  const out: Parsed = {
    command: cmd,
    positional: [],
    opts: defaultCommonOpts(),
    showHelp: false,
  };

  for (let i = 0; i < rest.length; i++){
    const a = rest[i];
    const next = () => rest[++i];

    switch (a){
      case '-h': case '--help':            out.showHelp = true; break;
      case '-v': case '--version':         out.command = 'version'; break;
      case '-d': case '--dir':             out.opts.dir = next(); break;
      case '--provider':                   out.opts.provider = next() as LLMProvider; break;
      case '--model':                      out.opts.model = next(); break;
      case '--api-key': case '--apikey':   out.opts.apiKey = next(); break;
      case '--base-url':                   out.opts.baseURL = next(); break;
      case '--quality':                    out.opts.quality = next() as CommonOpts['quality']; break;
      case '-m': case '--max':             out.opts.maxPages = parseInt(next(), 10); break;
      case '--flows':                      out.opts.maxFlows = parseInt(next(), 10); break;
      case '--no-headless':                out.opts.headless = false; break;
      case '--label':                      out.opts.label = next(); break;
      case '--json':                       out.opts.json = true; break;
      case '--fail-on-5xx':                out.opts.failOn5xx = true; break;
      case '--no-fail-on-5xx':             out.opts.failOn5xx = false; break;
      case '--heal':                       out.opts.heal = true; break;
      case '--bug': {
        const fp = next();
        if (!fp) die(2, '--bug requires a fingerprint');
        out.opts.bug = fp;
        break;
      }
      case '--repeat': {
        const n = parseInt(next(), 10);
        if (!Number.isInteger(n) || n < 1) die(2, '--repeat must be a positive integer');
        out.opts.repeat = n;
        break;
      }
      default:
        if (a.startsWith('-')){
          die(2, `Unknown flag: ${a}`);
        }
        out.positional.push(a);
    }
  }

  return out;
}

/* ── LLM config resolution ────────────────────────────────────────────── */

function buildLLMConfig(opts: CommonOpts): MonkeyLLMConfig {

  // Honour explicit --provider, otherwise let autoLLMConfig pick from env.
  if (opts.provider){
    const single: LLMConfig = {
      provider: opts.provider,
      model: opts.model,
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
    };
    return {
      explorer: { ...single, model: opts.model || CHEAP_FAST_MODEL[opts.provider] },
      planner:  single,
      runner:   { ...single, model: opts.model || CHEAP_FAST_MODEL[opts.provider] },
    };
  }

  return autoLLMConfig({ quality: opts.quality });

}

function ensureLLMReady(opts: CommonOpts){
  if (opts.provider) return;
  const detected = detectProviderFromEnv();
  if (!detected){
    die(2,
      'No LLM provider configured. Set one of: '
      + 'GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, MISTRAL_API_KEY, '
      + 'GROQ_API_KEY, or OPENAI_COMPATIBLE_BASE_URL — or pass --provider explicitly.'
    );
  }
}

/* ── Help ─────────────────────────────────────────────────────────────── */

function printHelp(cmd?: string){

  if (!cmd || cmd === 'help'){
    console.log(`
${tty('monkeytest', 'bold')} — the AI bug-finding loop for any web app.

Usage:
  monkeytest <command> [args] [flags]

Commands:
  ${tty('init', 'cyan')}                       Scaffold a .monkeytest/ directory.
  ${tty('explore', 'cyan')} <url>              Crawl + plan only. Writes plan.json.
  ${tty('run', 'cyan')} <url>                  Full pipeline: explore + plan + run + triage.
  ${tty('rerun', 'cyan')} [<runId>]            Replay a stored trace. No LLM unless --heal.
  ${tty('verify', 'cyan')} [run]               Replay each bug trace and print a verdict.
  ${tty('diff', 'cyan')} <runA> <runB>         Diff two stored runs by bug fingerprint.
  ${tty('report', 'cyan')} [<runId>]           Pretty-print a stored run.
  ${tty('help', 'cyan')} [<command>]           Show help (this page or per-command).
  ${tty('version', 'cyan')}                    Print engine version and exit.

Common flags (apply to most commands):
  -d, --dir <path>           Working dir (default ./.monkeytest)
      --provider <id>        openai | gemini | anthropic | mistral | groq | openai_compatible
      --model <id>           Provider-specific model id
      --api-key <key>        Override env API key
      --base-url <url>       Required for openai_compatible (Ollama, vLLM, …)
      --quality <preset>     cheap | balanced | smart   (default balanced)
  -m, --max <n>              Max pages to crawl (default 8)
      --flows <n>            Max flows to plan (default 6)
      --no-headless          Show the browser window
      --label <text>         Free-form label saved on the plan/run
      --heal                 If a recorded locator misses, ask the LLM (rerun/verify)
      --repeat <n>           Replay each bug n times (verify, default 1)
      --bug <fingerprint>    Verify one bug
      --json                 Machine-readable output
      --fail-on-5xx          Fail steps that saw a same-origin HTTP ≥500 (default)
      --no-fail-on-5xx       Keep those 5xx responses as evidence only

Exit codes: 0 ok · 1 bugs still firing · 2 bad args / setup · 3 engine error.

Environment:
  GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, MISTRAL_API_KEY,
  GROQ_API_KEY, OPENAI_COMPATIBLE_BASE_URL

Quick start:
  monkeytest run https://example.com
  monkeytest rerun                    # replay the latest trace, no LLM
  monkeytest verify --repeat 3        # is each known bug actually fixed?
  monkeytest diff prev latest         # see what changed

Docs: https://docs.monkeytest.ai
`);
    return;
  }

  // Per-command help
  const text: Record<string, string> = {
    init: `monkeytest init [--dir .monkeytest]
Scaffold a working directory with config defaults. Idempotent.`,
    explore: `monkeytest explore <url> [--max 8] [--flows 6] [--no-headless]
Crawl <url>, summarise pages, generate a TestPlan. Writes plan.json + shots/.`,
    run: `monkeytest run <url> [--max 8] [--flows 6] [--quality balanced]
Run the full pipeline (explore + plan + run + triage). Writes plan.json,
runs/<id>.json, and screenshots. Exits with code 1 if blocking bugs found.
Same-origin HTTP ≥500 responses fail the step (--no-fail-on-5xx opts out).
The crawl reserves room for help/contact/about pages under a small --max.`,
    rerun: `monkeytest rerun [<runId>] [--heal] [--dir .monkeytest]
Replay the action trace stored on a run. Does not call the LLM.
--heal re-resolves a step whose locator no longer matches and marks it healed.
If <runId> is omitted, the latest run is replayed. Runs recorded before
traces existed fall back to re-executing the stored plan with the LLM.`,
    verify: `monkeytest verify [runDir|runId] [--bug <fingerprint>] [--repeat N] [--heal]
Replay each known bug's trace and print a verdict:
  fixed         the failing step passed on every attempt
  still_broken  the failing step failed on every attempt
  flaky         the bug fired on some but not all attempts
  healed        a stale locator was re-resolved (--heal) and the bug did not recur
  blocked       the failing step could not be reached
Exit 1 if any bug is still_broken or flaky. --json prints the report.`,
    diff: `monkeytest diff <runA> <runB>
Diff two stored runs by stable bug fingerprint. Use "latest"/"prev" as
shortcuts. Prints new / fixed / persisting / regressed bugs.`,
    report: `monkeytest report [<runId>] [--json]
Pretty-print a stored run (flows, bugs, evidence paths). Defaults to
"latest". Use --json for machine-readable output.`,
  };
  console.log(text[cmd] || `No help for "${cmd}". Try \`monkeytest help\`.`);

}

/* ── Commands ─────────────────────────────────────────────────────────── */

async function cmdInit(opts: CommonOpts){
  const dir = resolve(opts.dir);
  mkdirSync(dir, { recursive: true });
  mkdirSync(resolve(dir, 'runs'),  { recursive: true });
  mkdirSync(resolve(dir, 'shots'), { recursive: true });

  const config = resolve(dir, 'config.json');
  if (!existsSync(config)){
    writeFileSync(config, JSON.stringify({
      $schema: 'https://docs.monkeytest.ai/config-schema-v1.json',
      provider: opts.provider || 'auto',
      quality: opts.quality,
      maxPages: opts.maxPages,
      maxFlows: opts.maxFlows,
    }, null, 2));
  }

  const gitignore = resolve(dir, '.gitignore');
  if (!existsSync(gitignore)){
    writeFileSync(gitignore, [
      '# MonkeyTest local artefacts',
      'shots/',
      'runs/',
      '*.tmp',
      '',
      '# Keep config + plan tracked',
      '!config.json',
      '!plan.json',
      '',
    ].join('\n'));
  }

  console.log(`${tty('✓', 'green')} Initialised ${tty(relative(process.cwd(), dir) || '.', 'cyan')}/`);
  console.log(`  Tracked:    config.json, plan.json (after first run)`);
  console.log(`  Ignored:    shots/, runs/`);
  console.log(`\nNext: ${tty('monkeytest run https://example.com', 'cyan')}`);
}

async function cmdExplore(url: string | undefined, opts: CommonOpts){
  if (!url) die(2, 'Usage: monkeytest explore <url>');
  ensureLLMReady(opts);

  const monkey = new Monkey({ llm: buildLLMConfig(opts), strictOracles: true, failOn5xx: opts.failOn5xx });
  console.log(`\n→ Exploring ${tty(url, 'cyan')} (max ${opts.maxPages} pages, headless=${opts.headless})…\n`);

  const t0 = Date.now();
  const screenshotsDir = resolve(opts.dir, 'shots');
  mkdirSync(screenshotsDir, { recursive: true });

  const { siteMap, plan } = await monkey.exploreAndPlan(url, {
    explore: {
      maxPages: opts.maxPages,
      headless: opts.headless,
      screenshotsDir,
      onPage: (p) => console.log(`  · visited [${p.authGated ? 'auth' : 'open'}] ${p.url} — ${truncate(p.summary, 80)}`),
    },
    plan: { maxFlows: opts.maxFlows },
  });

  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  const sitemapFile = resolve(opts.dir, 'sitemap.json');
  mkdirSync(opts.dir, { recursive: true });
  writeFileSync(sitemapFile, JSON.stringify(siteMap, null, 2));
  const planFile = savePlan(plan, { dir: opts.dir, label: opts.label, engine: ENGINE_VERSION });

  console.log(summariseSiteMap(siteMap));
  console.log(summarisePlan(plan));
  console.log(`\n${tty('✓', 'green')} Done in ${dt}s.`);
  console.log(`  ${tty('sitemap', 'dim')} → ${relative(process.cwd(), sitemapFile)}`);
  console.log(`  ${tty('plan',    'dim')} → ${relative(process.cwd(), planFile)}\n`);
}

async function cmdRun(url: string | undefined, opts: CommonOpts){
  if (!url) die(2, 'Usage: monkeytest run <url>');
  ensureLLMReady(opts);

  const screenshotsDir = resolve(opts.dir, 'shots');
  mkdirSync(screenshotsDir, { recursive: true });

  const monkey = new Monkey({ llm: buildLLMConfig(opts), strictOracles: true, failOn5xx: opts.failOn5xx });
  console.log(`\n→ Running ${tty(url, 'cyan')} (max ${opts.maxPages} pages, ${opts.maxFlows} flows, headless=${opts.headless})…\n`);

  const t0 = Date.now();
  const { siteMap, plan, run } = await monkey.executeAndTriage(url, {
    explore: {
      maxPages: opts.maxPages,
      headless: opts.headless,
      screenshotsDir,
      onPage: (p) => console.log(`  · visited ${p.url}`),
    },
    plan: { maxFlows: opts.maxFlows },
    run:  {
      screenshotsDir,
      headless: opts.headless,
      onEvent: (evt) => {
        if (evt.type === 'flow.start') console.log(`  ▶ ${tty(evt.flow.name, 'magenta')}`);
        if (evt.type === 'step.complete'){
          const sym = evt.result.status === 'passed' ? tty('✓', 'green') : evt.result.status === 'failed' ? tty('✗', 'red') : tty('·', 'dim');
          console.log(`    ${sym} step ${evt.index}: ${truncate(evt.result.observation, 80)}`);
        }
      },
    },
  });

  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  const planFile = savePlan(plan, { dir: opts.dir, label: opts.label, engine: ENGINE_VERSION });
  const { path: runFile, id: runId } = saveRun(run, {
    dir: opts.dir,
    planRef: { path: planFile, createdAt: new Date().toISOString() },
    engine: ENGINE_VERSION,
  });

  if (opts.json){
    console.log(JSON.stringify({ siteMap, plan, run, runId, runFile, planFile }, null, 2));
  } else {
    console.log(summariseSiteMap(siteMap));
    console.log(summarisePlan(plan));
    console.log(summariseRun(run));
  }

  console.log(`\n${tty('✓', 'green')} Done in ${dt}s.`);
  console.log(`  ${tty('plan', 'dim')} → ${relative(process.cwd(), planFile)}`);
  console.log(`  ${tty('run',  'dim')} → ${relative(process.cwd(), runFile)}  (id: ${tty(runId, 'cyan')})`);

  const blocking = run.bugs.filter(b => b.severity !== 'minor');
  if (blocking.length){
    console.error(`\n${tty(`✗ ${blocking.length} blocking bug${blocking.length === 1 ? '' : 's'} found.`, 'red')}`);
    process.exit(1);
  }
}

async function cmdRerun(runId: string | undefined, opts: CommonOpts){
  const stored = storedRunForRerun(runId, opts);
  const traces = stored ? tracesOf(stored.run) : [];

  if (stored && traces.length > 0){
    return replayStoredRun(stored, traces, opts);
  }

  if (stored){
    console.log(tty('No action trace on this run. Falling back to LLM re-resolution of the stored plan.', 'yellow'));
  }
  return rerunStoredPlan(stored, opts);
}

async function replayStoredRun(stored: StoredRun, traces: FlowTrace[], opts: CommonOpts){
  if (opts.heal) ensureLLMReady(opts);

  const screenshotsDir = resolve(opts.dir, 'shots');
  mkdirSync(screenshotsDir, { recursive: true });

  console.log(`\n↻ Replaying ${traces.length} trace(s) from ${tty(stored.id, 'cyan')}${opts.heal ? ' (heal on)' : ''}…\n`);
  const t0 = Date.now();
  const raw = await replayTraces(traces, {
    screenshotsDir,
    headless: opts.headless,
    heal: opts.heal,
    llm: opts.heal ? runnerLLM(opts) : undefined,
    strictOracles: true,
    failOn5xx: opts.failOn5xx,
  });
  const run = triage(raw, { failOn5xx: opts.failOn5xx });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const { path: runFile, id: newRunId } = saveRun(run, {
    dir: opts.dir,
    planRef: stored.planRef,
    engine: ENGINE_VERSION,
  });

  if (opts.json){
    console.log(JSON.stringify({ run, runId: newRunId, runFile, replay: true, heal: opts.heal }, null, 2));
  } else {
    console.log(summariseRun(run));
    const healed = run.flows.reduce((n, flow) => n + flow.steps.filter(step => step.resolution === 'healed').length, 0);
    if (healed) console.log(`  healed steps: ${healed}`);
  }
  console.log(`\n${tty('✓', 'green')} Replay complete in ${dt}s.`);
  console.log(`  ${tty('run', 'dim')} → ${relative(process.cwd(), runFile)}  (id: ${tty(newRunId, 'cyan')})`);
  suggestDiff(opts.dir, newRunId);
  exitIfBlocking(run);
}

async function rerunStoredPlan(stored: StoredRun | undefined, opts: CommonOpts){
  ensureLLMReady(opts);

  // Resolve plan: an explicit run means "use the plan stored alongside that run",
  // otherwise just load the canonical plan.json.
  let storedPlan;
  let planSource: string;

  if (stored?.planRef?.path){
    storedPlan = loadPlan(stored.planRef.path);
    planSource = stored.planRef.path;
  } else if (stored){
    die(2, `Stored run ${stored.id} has no action trace and no planRef. Cannot rerun.`);
    return;
  } else {
    storedPlan = loadPlan(opts.dir);
    planSource = resolve(opts.dir, 'plan.json');
  }

  const screenshotsDir = resolve(opts.dir, 'shots');
  mkdirSync(screenshotsDir, { recursive: true });

  const monkey = new Monkey({ llm: buildLLMConfig(opts), strictOracles: true, failOn5xx: opts.failOn5xx });
  console.log(`\n↻ Re-running ${storedPlan.plan.flows.length} flow(s) from ${tty(relative(process.cwd(), planSource), 'cyan')}…\n`);

  const t0 = Date.now();
  const { run } = await monkey.runFromPlan(storedPlan.plan, {
    run: {
      screenshotsDir,
      headless: opts.headless,
      onEvent: (evt) => {
        if (evt.type === 'flow.start') console.log(`  ▶ ${tty(evt.flow.name, 'magenta')}`);
        if (evt.type === 'step.complete'){
          const sym = evt.result.status === 'passed' ? tty('✓', 'green') : evt.result.status === 'failed' ? tty('✗', 'red') : tty('·', 'dim');
          console.log(`    ${sym} step ${evt.index}: ${truncate(evt.result.observation, 80)}`);
        }
      },
    },
  });

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const { path: runFile, id: newRunId } = saveRun(run, {
    dir: opts.dir,
    planRef: { path: planSource, createdAt: storedPlan.createdAt },
    engine: ENGINE_VERSION,
  });

  console.log(summariseRun(run));
  console.log(`\n${tty('✓', 'green')} Re-run complete in ${dt}s.`);
  console.log(`  ${tty('run', 'dim')} → ${relative(process.cwd(), runFile)}  (id: ${tty(newRunId, 'cyan')})`);

  // Auto-suggest a diff if there's a previous run to compare against.
  const ids = listRuns(opts.dir);
  if (ids.length >= 2){
    const previousId = ids[1]; // listRuns returns newest-first; [0] is the run we just wrote
    console.log(`\n${tty('Tip:', 'dim')} compare to previous run with:`);
    console.log(`  ${tty(`monkeytest diff ${previousId} ${newRunId}`, 'cyan')}`);
  }

  exitIfBlocking(run);
}

async function cmdVerify(positional: string | undefined, opts: CommonOpts){
  const stored = resolveStoredRun(positional, opts);
  if (opts.bug && !stored.run.bugs.some(bug => bugMatchesFingerprint(bug, opts.bug!))){
    const known = stored.run.bugs.map(bug => bug.fingerprint).slice(0, 8).join(', ');
    die(2, `No bug with fingerprint ${opts.bug} on run ${stored.id}.${known ? ` Known: ${known}` : ''}`);
  }
  if (opts.heal) ensureLLMReady(opts);

  const screenshotsDir = resolve(opts.dir, 'shots');
  mkdirSync(screenshotsDir, { recursive: true });

  if (!opts.json){
    const scope = opts.bug ? `bug ${opts.bug}` : `${stored.run.bugs.length} bug(s)`;
    console.log(`\n→ Verifying ${scope} from ${tty(stored.id, 'cyan')} (repeat ${opts.repeat}${opts.heal ? ', heal' : ''})…\n`);
  }

  const report = await verifyBugs(stored.run, {
    screenshotsDir,
    headless: opts.headless,
    heal: opts.heal,
    llm: opts.heal ? runnerLLM(opts) : undefined,
    repeat: opts.repeat,
    fingerprints: opts.bug ? [opts.bug] : undefined,
    recordVideo: false,
    strictOracles: true,
    failOn5xx: opts.failOn5xx,
  });

  if (opts.json){
    console.log(JSON.stringify({ runId: stored.id, ...report }, null, 2));
  } else {
    printVerifyTable(stored.id, report);
  }

  if (report.exitCode !== 0){
    const broken = report.stats.still_broken + report.stats.flaky;
    console.error(tty(`✗ ${broken} bug${broken === 1 ? '' : 's'} still firing.`, 'red'));
    process.exit(report.exitCode);
  }
}

function cmdDiff(a: string | undefined, b: string | undefined, opts: CommonOpts){
  if (!a || !b) die(2, 'Usage: monkeytest diff <runA> <runB>');

  const ids = listRuns(opts.dir);
  const resolveId = (s: string) => {
    if (s === 'latest') return ids[0];
    if (s === 'prev')   return ids[1];
    return s;
  };
  const idA = resolveId(a!);
  const idB = resolveId(b!);
  if (!idA || !idB) die(2, `Could not resolve run id(s). Available: ${ids.slice(0, 5).join(', ') || '(none)'}`);

  const runA = loadRun(idA, { dir: opts.dir });
  const runB = loadRun(idB, { dir: opts.dir });

  const diff = diffRuns(runA.run, runB.run);

  if (opts.json){
    console.log(JSON.stringify({ from: idA, to: idB, diff }, null, 2));
    return;
  }

  console.log(`\n${tty('Diff', 'bold')} ${tty(idA, 'dim')} → ${tty(idB, 'dim')}`);
  console.log(`  ${tty(summariseDiff(diff), 'bold')}\n`);

  printDiffSection('New bugs',         diff.newBugs,        'red');
  printDiffSection('Regressed bugs',   diff.regressedBugs,  'red');
  printDiffSection('Fixed bugs',       diff.fixedBugs,      'green');
  printDiffSection('Still broken',     diff.persistingBugs, 'yellow');

  // Exit 1 if anything got worse, so CI can gate on this
  if (diff.newBugs.length > 0 || diff.regressedBugs.length > 0){
    process.exit(1);
  }
}

function cmdReport(runId: string | undefined, opts: CommonOpts){
  const id = runId || 'latest';
  const stored = loadRun(id, { dir: opts.dir });
  const { run } = stored;

  if (opts.json){
    console.log(JSON.stringify(stored, null, 2));
    return;
  }

  console.log(`\n${tty('Report', 'bold')} for run ${tty(stored.id, 'cyan')}  (${stored.createdAt})`);
  if (stored.planRef?.path){
    console.log(`  ${tty('plan', 'dim')}: ${stored.planRef.path}`);
  }
  console.log(summariseRun(run));

  for (const flow of run.flows){
    const sym = flow.status === 'passed' ? tty('✓', 'green') : flow.status === 'failed' ? tty('✗', 'red') : tty('·', 'yellow');
    console.log(`\n  ${sym} ${tty(flow.name, 'bold')}  (${flow.steps.length} steps, ${(flow.durationMs / 1000).toFixed(1)}s)`);
    for (const s of flow.steps){
      const ssym = s.status === 'passed' ? tty('✓', 'green') : s.status === 'failed' ? tty('✗', 'red') : tty('·', 'dim');
      console.log(`      ${ssym} ${s.index}. ${truncate(s.action, 80)}`);
      if (s.screenshotPath) console.log(`         ${tty('shot', 'dim')}: ${relative(process.cwd(), s.screenshotPath)}`);
    }
  }

  if (run.bugs.length){
    console.log(`\n  ${tty('Bugs:', 'bold')}`);
    for (const b of run.bugs){
      const sev = b.severity === 'critical' ? tty(b.severity, 'red')
        : b.severity === 'major' ? tty(b.severity, 'yellow')
        : tty(b.severity, 'dim');
      console.log(`    [${sev}] ${b.title}`);
      console.log(`           ${tty('observed:', 'dim')} ${truncate(b.observed, 100)}`);
      console.log(`           ${tty('fingerprint:', 'dim')} ${b.fingerprint}`);
    }
  }
  console.log();
}

/* ── Pretty-print helpers ─────────────────────────────────────────────── */

function summariseSiteMap(siteMap: { startUrl: string; siteType: string; summary: string; pages: unknown[]; pendingUrls: unknown[]; failedUrls: unknown[] }): string {
  return `\n${tty('SiteMap', 'bold')}
  start:    ${siteMap.startUrl}
  type:     ${siteMap.siteType}
  summary:  ${truncate(siteMap.summary, 200)}
  pages:    ${siteMap.pages.length} visited, ${siteMap.pendingUrls.length} pending, ${siteMap.failedUrls.length} failed`;
}

function summarisePlan(plan: { flows: { name: string; kind: string; steps: unknown[] }[]; notes?: string }): string {
  if (plan.flows.length === 0) return `\n${tty('Plan', 'bold')}\n  (no flows)`;
  const lines = plan.flows.map((f, i) => `  ${i + 1}. [${f.kind}] ${f.name}  (${f.steps.length} steps)`);
  return `\n${tty('Plan', 'bold')}\n${lines.join('\n')}${plan.notes ? `\n  notes: ${plan.notes}` : ''}`;
}

function summariseRun(run: { stats: { flowsTotal: number; flowsPassed: number; flowsFailed: number; bugsCritical: number; bugsMajor: number; bugsMinor: number } }): string {
  const { flowsTotal, flowsPassed, flowsFailed, bugsCritical, bugsMajor, bugsMinor } = run.stats;
  return `\n${tty('Run', 'bold')}
  flows:    ${tty(`${flowsPassed}/${flowsTotal}`, flowsFailed === 0 ? 'green' : 'yellow')} passed, ${flowsFailed} failed
  bugs:     ${tty(String(bugsCritical), bugsCritical ? 'red' : 'dim')} critical, ${tty(String(bugsMajor), bugsMajor ? 'yellow' : 'dim')} major, ${tty(String(bugsMinor), 'dim')} minor`;
}

function printDiffSection(title: string, entries: { fingerprint: string; bug: BugReport }[], colour: keyof typeof c){
  if (entries.length === 0) return;
  console.log(`  ${tty(`${title} (${entries.length})`, colour)}`);
  for (const e of entries){
    console.log(`    [${e.bug.severity}] ${e.bug.title}`);
    console.log(`           ${tty('fingerprint:', 'dim')} ${e.fingerprint}`);
  }
  console.log();
}

function printVerifyTable(runId: string, report: VerifyReport){
  const { stats } = report;
  console.log(`${tty('Verify', 'bold')} ${tty(runId, 'dim')}`);
  console.log(
    `  ${tty(String(stats.fixed), 'green')} fixed, `
    + `${tty(String(stats.still_broken), stats.still_broken ? 'red' : 'dim')} still broken, `
    + `${tty(String(stats.flaky), stats.flaky ? 'yellow' : 'dim')} flaky, `
    + `${tty(String(stats.healed), stats.healed ? 'cyan' : 'dim')} healed, `
    + `${tty(String(stats.blocked), 'dim')} blocked\n`,
  );
  if (report.results.length === 0){
    console.log('  No bugs to verify.\n');
    return;
  }
  console.log(`  ${'fingerprint'.padEnd(18)} ${'verdict'.padEnd(14)} ${'fired'.padEnd(8)} title`);
  for (const row of report.results){
    const colour = row.verdict === 'fixed' ? 'green'
      : row.verdict === 'still_broken' ? 'red'
      : row.verdict === 'flaky' ? 'yellow'
      : row.verdict === 'healed' ? 'cyan'
      : 'dim';
    const shown = row.fingerprintV2 || row.fingerprint;
    console.log(`  ${shown.padEnd(18)} ${tty(row.verdict.padEnd(14), colour)} ${`${row.fired}/${row.repeat}`.padEnd(8)} ${truncate(row.title, 72)}`);
    if (row.verdict !== 'fixed'){
      console.log(`  ${''.padEnd(18)} ${tty(truncate(row.detail, 110), 'dim')}`);
    }
  }
  console.log();
}

function storedRunForRerun(runId: string | undefined, opts: CommonOpts): StoredRun | undefined {
  if (runId) return loadRun(runId, { dir: opts.dir });
  const ids = listRuns(opts.dir);
  if (ids.length === 0) return undefined;
  return loadRun(ids[0], { dir: opts.dir });
}

function resolveStoredRun(positional: string | undefined, opts: CommonOpts): StoredRun {
  if (!positional || positional === 'latest' || positional === 'prev'){
    const ids = listRuns(opts.dir);
    const id = positional === 'prev' ? ids[1] : ids[0];
    if (!id) die(2, `No runs found under ${resolve(opts.dir, 'runs')}.`);
    return loadRun(id, { dir: opts.dir });
  }
  const abs = resolve(positional);
  if (existsSync(abs) && statSync(abs).isDirectory()){
    return loadRun('latest', { dir: abs });
  }
  if (positional.endsWith('.json') || existsSync(abs)){
    return loadRun(abs);
  }
  return loadRun(positional, { dir: opts.dir });
}

function tracesOf(run: RunResult): FlowTrace[] {
  return run.flows
    .map(flow => flow.trace)
    .filter((trace): trace is FlowTrace => !!trace && trace.steps.length > 0);
}

function runnerLLM(opts: CommonOpts): LLM {
  const cfg = buildLLMConfig(opts);
  return createLLM(cfg.runner ?? cfg.planner);
}

function suggestDiff(dir: string, newRunId: string){
  const ids = listRuns(dir);
  if (ids.length >= 2){
    const previousId = ids[1];
    console.log(`\n${tty('Tip:', 'dim')} compare to previous run with:`);
    console.log(`  ${tty(`monkeytest diff ${previousId} ${newRunId}`, 'cyan')}`);
  }
}

function exitIfBlocking(run: RunResult){
  const blocking = run.bugs.filter(bug => bug.severity !== 'minor');
  if (blocking.length){
    console.error(`\n${tty(`✗ ${blocking.length} blocking bug${blocking.length === 1 ? '' : 's'} still failing.`, 'red')}`);
    process.exit(1);
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function die(code: number, msg: string): never {
  console.error(tty(msg, 'red'));
  process.exit(code);
}

/* ── Entrypoint ───────────────────────────────────────────────────────── */

async function main(){
  const args = parseArgs(process.argv);

  if (args.command === 'help' || args.showHelp){
    // If the user typed `monkeytest help <cmd>` we show that command's help.
    // Otherwise (`monkeytest --help` or no command) show the top-level help.
    const sub = args.command === 'help' ? args.positional[0] : args.command;
    printHelp(sub);
    return;
  }

  if (args.command === 'version'){
    console.log(ENGINE_VERSION);
    return;
  }

  switch (args.command){
    case 'init':    return cmdInit(args.opts);
    case 'explore': return cmdExplore(args.positional[0], args.opts);
    case 'run':     return cmdRun(args.positional[0], args.opts);
    case 'rerun':   return cmdRerun(args.positional[0], args.opts);
    case 'verify':  return cmdVerify(args.positional[0], args.opts);
    case 'diff':    return cmdDiff(args.positional[0], args.positional[1], args.opts);
    case 'report':  return cmdReport(args.positional[0], args.opts);
    default:
      console.error(tty(`Unknown command: ${args.command}`, 'red'));
      printHelp();
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(`\n${tty('✗ monkeytest failed:', 'red')} ${err instanceof Error ? err.message : err}`);
  if (process.env.MONKEYTEST_DEBUG && err instanceof Error && err.stack){
    console.error(err.stack);
  }
  process.exit(3);
});
