/**
 * Top-level engine orchestrator.
 *
 * Two ways to use it:
 *
 *   1. `await monkey.exploreAndPlan(url)` — one-shot promise; easiest for the
 *      CLI and for unit-testing the explorer/planner.
 *   2. `await monkey.executeAndTriage(url, { events })` — full pipeline;
 *      pass an `EventBus` to receive realtime lifecycle events for a SaaS
 *      live-activity panel.
 */

import { createLLM, type LLM } from './llm/index.js';
import { explore, type ExploreOptions } from './explorer/index.js';
import { plan, type PlannerOptions } from './planner/index.js';
import { runPlan, type RunnerOptions } from './runner/index.js';
import { replayTraces, type ReplayOptions } from './runner/replay.js';
import { triage, triagePolished } from './triager/index.js';
import { verifyBugs, type VerifyOptions, type VerifyReport } from './verify/index.js';
import { EventBus, noopBus } from './events.js';
import type {
  MonkeyLLMConfig,
  SiteMap,
  TestPlan,
  RunResult,
  MonkeyEvent,
} from './types.js';

export interface MonkeyConfig {
  llm: MonkeyLLMConfig;
  /**
   * Fail a step on an uncaught page error, a document HTTP 404, an action
   * HTTP ≥500, or a disabled control the step tried to use. Default **on**.
   * Pass `false` to restore the previous "those signals stay evidence"
   * bug counts. The CLI always passes `true`. A per-call `run.strictOracles`
   * overrides the constructor.
   */
  strictOracles?: boolean;
  /**
   * Fail a passed or skipped step that observed a same-origin HTTP ≥500
   * (document, xhr, or fetch) and triage it as a blocking bug. Default
   * **on**. Pass `false` to leave those responses as evidence. The CLI
   * defaults this on (`--no-fail-on-5xx` opts out). A per-call
   * `run.failOn5xx` or replay `failOn5xx` overrides the constructor.
   *
   * `runPlan`, `replayTraces`, and `triage(run)` still leave this off unless
   * the caller passes it. `Monkey` passes the constructor value through.
   */
  failOn5xx?: boolean;
}

/**
 * Product defaults for hard-fault oracles. Both are on unless the host
 * passes `false`. `runPlan` / `triage(run)` do not use this helper; `Monkey` does.
 */
export function resolveMonkeyOracles(
  config: Pick<MonkeyConfig, 'strictOracles' | 'failOn5xx'> = {},
): { strictOracles: boolean; failOn5xx: boolean } {
  return {
    strictOracles: config.strictOracles !== false,
    failOn5xx: config.failOn5xx !== false,
  };
}

export interface ExploreAndPlanOptions {
  explore?: ExploreOptions;
  plan?: PlannerOptions;
  /** Optional live event bus. Receives `LiveEvent`s for the explorer + planner phases. */
  events?: EventBus;
}

export interface ExecuteOptions extends ExploreAndPlanOptions {
  /**
   * Runner config. `screenshotsDir` is required because step screenshots
   * are the most valuable artefact a SaaS report can show.
   */
  run: RunnerOptions;
}

/**
 * Options for the `runFromPlan` re-run path. Skips explore + plan, executes
 * an existing TestPlan and triages the result. This is the cheap, fast path
 * for verifying that previously-found bugs are now fixed.
 */
export interface ExecuteFromPlanOptions {
  /** Required runner config; same shape as `executeAndTriage.run`. */
  run: RunnerOptions;
  /** Optional live event bus. Receives runner + triager events only. */
  events?: EventBus;
}

export class Monkey {

  private readonly explorerLLM: LLM;
  private readonly plannerLLM: LLM;
  private readonly runnerLLM: LLM;
  /** Optional polish LLM; when present, the triager rewrites bug copy. */
  private readonly triagerLLM?: LLM;
  /** Page error, document 404, action 5xx, disabled control. On unless opted out. */
  private readonly strictOracles: boolean;
  /** Same-origin HTTP ≥500 promotion. On unless opted out. */
  private readonly failOn5xx: boolean;

  constructor(config: MonkeyConfig){

    this.explorerLLM = createLLM(config.llm.explorer);
    this.plannerLLM  = createLLM(config.llm.planner);
    // Runner picks its own LLM if provided; otherwise it reuses the planner.
    // Most teams will want a *cheaper* runner (per-step tool resolution is
    // hot-path) and a smarter planner (one-shot, high-stakes design call).
    this.runnerLLM   = config.llm.runner
      ? createLLM(config.llm.runner)
      : this.plannerLLM;
    // Triager polish is fully opt-in. When unset, the deterministic
    // rule-based triager runs alone (zero LLM cost).
    this.triagerLLM  = config.llm.triager ? createLLM(config.llm.triager) : undefined;
    const oracles = resolveMonkeyOracles(config);
    this.strictOracles = oracles.strictOracles;
    this.failOn5xx = oracles.failOn5xx;

  }

  /**
   * One-shot helper: crawl the site and produce the test plan.
   */
  async exploreAndPlan(
    startUrl: string,
    opts: ExploreAndPlanOptions = {}
  ): Promise<{ siteMap: SiteMap; plan: TestPlan }> {

    const events = opts.events ?? noopBus();

    const siteMap = await explore(startUrl, this.explorerLLM, { ...opts.explore, events });
    const testPlan = await plan(siteMap, this.plannerLLM, { ...opts.plan, events });
    return { siteMap, plan: testPlan };

  }

  /**
   * Full pipeline: explore → plan → run → triage.
   *
   * Resilient by design: if the explorer reaches no pages, or the planner
   * fails, we still resolve with whatever evidence we have so the report
   * can render the failure clearly instead of showing an empty page.
   */
  async executeAndTriage(
    startUrl: string,
    opts: ExecuteOptions
  ): Promise<{ siteMap: SiteMap; plan: TestPlan; run: RunResult }> {

    const events = opts.events ?? noopBus();

    const siteMap = await explore(startUrl, this.explorerLLM, { ...opts.explore, events });

    let testPlan: TestPlan;
    try {
      testPlan = await plan(siteMap, this.plannerLLM, { ...opts.plan, events });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      events.emit({
        phase: 'planner', type: 'engine.error',
        message: `Planner failed: ${truncate(msg, 160)}`,
        data: { error: msg },
      });
      return {
        siteMap,
        plan: {
          startUrl,
          siteType: siteMap.siteType,
          flows: [],
          notes: `Planner failed after exploration: ${msg}`,
        },
        run: emptyRun(startUrl),
      };
    }

    if (testPlan.flows.length === 0){
      events.emit({
        phase: 'planner', type: 'plan.skipped',
        message: 'Planner produced no flows — nothing to execute.',
      });
      return { siteMap, plan: testPlan, run: emptyRun(startUrl) };
    }

    let rawRun: RunResult;
    try {
      events.emit({
        phase: 'runner', type: 'run.start',
        message: `Running ${testPlan.flows.length} flow${testPlan.flows.length === 1 ? '' : 's'}…`,
        data: { flows: testPlan.flows.length },
      });
      rawRun = await runPlan(testPlan, this.runnerLLM, {
        ...opts.run,
        events,
        strictOracles: opts.run.strictOracles ?? this.strictOracles,
        failOn5xx: opts.run.failOn5xx ?? this.failOn5xx,
      });
      events.emit({
        phase: 'runner', type: 'run.complete',
        message: `Run complete: ${rawRun.stats.flowsPassed}/${rawRun.stats.flowsTotal} flows passed.`,
        data: rawRun.stats,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      events.emit({
        phase: 'runner', type: 'engine.error',
        message: `Runner failed: ${truncate(msg, 160)}`,
        data: { error: msg },
      });
      return {
        siteMap,
        plan: {
          ...testPlan,
          notes: [testPlan.notes, `Runner failed before executing flows: ${msg}`].filter(Boolean).join('\n'),
        },
        run: emptyRun(startUrl),
      };
    }

    let run: RunResult;
    if (this.triagerLLM){
      // Polished path: rule-based triage runs first inside `triagePolished`,
      // then each bug is rewritten by the LLM. Failures fall back to the
      // deterministic copy per-bug — never lose results.
      run = await triagePolished(rawRun, {
        llm: this.triagerLLM,
        events,
        failOn5xx: opts.run.failOn5xx ?? this.failOn5xx,
      });
    } else {
      events.emit({ phase: 'triager', type: 'triage.start', message: 'Triaging findings…' });
      run = triage(rawRun, { failOn5xx: opts.run.failOn5xx ?? this.failOn5xx });
      events.emit({
        phase: 'triager', type: 'triage.complete',
        message: run.bugs.length === 0
          ? 'Triage complete: no confirmed bugs.'
          : `Triage complete: ${run.bugs.length} bug${run.bugs.length === 1 ? '' : 's'} reported.`,
        data: { bugs: run.bugs.length, stats: run.stats },
      });
    }

    return { siteMap, plan: testPlan, run };

  }

  /**
   * Re-run a previously-stored `TestPlan` against the same (or a new) URL,
   * skipping the explorer and planner phases entirely.
   *
   * This re-executes the stored plan. The runner still asks the LLM which
   * tool to use at each step, so it is not a byte-for-byte replay.
   *
   * For a replay that does not call the LLM, use `replayRecorded` (the CLI
   * `rerun` command) or `verifyRecorded` (`monkeytest verify`). Those walk
   * the action trace captured on the original run.
   *
   * Re-using the stored plan still gives:
   *
   *   - **Same flows** — no explorer or planner drift between runs.
   *   - **Speed + cost** — no explorer LLM calls and no planner call.
   *   - **Comparability** — pair the result with `diffRuns(prev, current)`
   *     to see new / fixed / regressed bugs by stable fingerprint.
   *
   * The plan's `startUrl` is honoured by default. If you want to re-run the
   * same plan against a different environment (e.g. staging vs prod), edit
   * `plan.flows[].startUrl` before passing it in.
   */
  async runFromPlan(
    testPlan: TestPlan,
    opts: ExecuteFromPlanOptions
  ): Promise<{ plan: TestPlan; run: RunResult }> {

    const events = opts.events ?? noopBus();

    if (testPlan.flows.length === 0){
      events.emit({
        phase: 'planner', type: 'plan.skipped',
        message: 'runFromPlan called with an empty plan — nothing to execute.',
      });
      return { plan: testPlan, run: emptyRun(testPlan.startUrl) };
    }

    let rawRun: RunResult;
    try {
      events.emit({
        phase: 'runner', type: 'run.start',
        message: `Re-running ${testPlan.flows.length} stored flow${testPlan.flows.length === 1 ? '' : 's'}…`,
        data: { flows: testPlan.flows.length, mode: 'rerun' },
      });
      rawRun = await runPlan(testPlan, this.runnerLLM, {
        ...opts.run,
        events,
        strictOracles: opts.run.strictOracles ?? this.strictOracles,
        failOn5xx: opts.run.failOn5xx ?? this.failOn5xx,
      });
      events.emit({
        phase: 'runner', type: 'run.complete',
        message: `Re-run complete: ${rawRun.stats.flowsPassed}/${rawRun.stats.flowsTotal} flows passed.`,
        data: rawRun.stats,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      events.emit({
        phase: 'runner', type: 'engine.error',
        message: `Re-run failed: ${truncate(msg, 160)}`,
        data: { error: msg },
      });
      return { plan: testPlan, run: emptyRun(testPlan.startUrl) };
    }

    let run: RunResult;
    if (this.triagerLLM){
      run = await triagePolished(rawRun, {
        llm: this.triagerLLM,
        events,
        failOn5xx: opts.run.failOn5xx ?? this.failOn5xx,
      });
    } else {
      events.emit({ phase: 'triager', type: 'triage.start', message: 'Triaging findings…' });
      run = triage(rawRun, { failOn5xx: opts.run.failOn5xx ?? this.failOn5xx });
      events.emit({
        phase: 'triager', type: 'triage.complete',
        message: run.bugs.length === 0
          ? 'Triage complete: no confirmed bugs.'
          : `Triage complete: ${run.bugs.length} bug${run.bugs.length === 1 ? '' : 's'} reported.`,
        data: { bugs: run.bugs.length, stats: run.stats },
      });
    }

    return { plan: testPlan, run };

  }

  /**
   * Replay traces captured on a previous run. Does not call the LLM unless
   * `opts.heal` is set, in which case a missed locator is re-resolved with
   * the runner model and that step is marked `healed`.
   */
  async replayRecorded(
    source: RunResult,
    opts: ReplayOptions & { heal?: boolean },
  ): Promise<{ run: RunResult }> {
    const traces = source.flows
      .map(flow => flow.trace)
      .filter((trace): trace is NonNullable<typeof trace> => !!trace && trace.steps.length > 0);
    const raw = await replayTraces(traces, {
      ...opts,
      heal: opts.heal,
      llm: opts.heal ? (opts.llm ?? this.runnerLLM) : opts.llm,
      strictOracles: opts.strictOracles ?? this.strictOracles,
      failOn5xx: opts.failOn5xx ?? this.failOn5xx,
    });
    const failOn5xx = opts.failOn5xx ?? this.failOn5xx;
    const run = this.triagerLLM
      ? await triagePolished(raw, { llm: this.triagerLLM, failOn5xx })
      : triage(raw, { failOn5xx });
    return { run };
  }

  /**
   * Replay each bug trace on `source` and return a fixed / still_broken /
   * flaky / healed / blocked verdict. No LLM unless `opts.heal` is set.
   */
  async verifyRecorded(source: RunResult, opts: VerifyOptions): Promise<VerifyReport> {
    return verifyBugs(source, {
      ...opts,
      llm: opts.heal ? (opts.llm ?? this.runnerLLM) : opts.llm,
      strictOracles: opts.strictOracles ?? this.strictOracles,
      failOn5xx: opts.failOn5xx ?? this.failOn5xx,
    });
  }

  /**
   * Async-iterator API. Same pipeline, but yields MonkeyEvents as it goes
   * so the caller can stream them. v0.2 yields explore + plan + flow/step
   * events.
   */
  async *run(
    startUrl: string,
    opts: ExploreAndPlanOptions = {}
  ): AsyncGenerator<MonkeyEvent, void, void> {

    yield { type: 'explore.start', url: startUrl };

    const pageEvents: MonkeyEvent[] = [];
    const siteMap = await explore(startUrl, this.explorerLLM, {
      ...opts.explore,
      onPage: (page) => {
        pageEvents.push({ type: 'explore.page', page });
      },
    });
    for (const e of pageEvents) yield e;

    yield { type: 'explore.complete', siteMap };
    yield { type: 'plan.start' };

    let testPlan: TestPlan;
    try {
      testPlan = await plan(siteMap, this.plannerLLM, opts.plan);
    } catch (err) {
      yield {
        type: 'error',
        phase: 'planner',
        message: err instanceof Error ? err.message : String(err),
      };
      return;
    }

    yield { type: 'plan.complete', plan: testPlan };

  }

}

function emptyRun(startUrl: string): RunResult {
  const startedAt = new Date().toISOString();
  return {
    startUrl,
    startedAt,
    finishedAt: startedAt,
    flows: [],
    bugs: [],
    stats: {
      flowsTotal: 0, flowsPassed: 0, flowsFailed: 0, flowsBlocked: 0,
      stepsTotal: 0, stepsPassed: 0, stepsFailed: 0,
      bugsCritical: 0, bugsMajor: 0, bugsMinor: 0,
    },
  };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
