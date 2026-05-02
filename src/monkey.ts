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
import { triage } from './triager/index.js';
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

export class Monkey {

  private readonly explorerLLM: LLM;
  private readonly plannerLLM: LLM;
  private readonly runnerLLM: LLM;

  constructor(config: MonkeyConfig){

    this.explorerLLM = createLLM(config.llm.explorer);
    this.plannerLLM  = createLLM(config.llm.planner);
    // The runner uses the planner's model by default — its job (translate
    // a step into a tool call) is structurally similar to planner work.
    this.runnerLLM   = this.plannerLLM;

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
      rawRun = await runPlan(testPlan, this.runnerLLM, { ...opts.run, events });
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

    events.emit({ phase: 'triager', type: 'triage.start', message: 'Triaging findings…' });
    const run = triage(rawRun);
    events.emit({
      phase: 'triager', type: 'triage.complete',
      message: run.bugs.length === 0
        ? 'Triage complete: no confirmed bugs.'
        : `Triage complete: ${run.bugs.length} bug${run.bugs.length === 1 ? '' : 's'} reported.`,
      data: { bugs: run.bugs.length, stats: run.stats },
    });

    return { siteMap, plan: testPlan, run };

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
      flowsTotal: 0, flowsPassed: 0, flowsFailed: 0,
      stepsTotal: 0, stepsPassed: 0, stepsFailed: 0,
      bugsCritical: 0, bugsMajor: 0, bugsMinor: 0,
    },
  };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
