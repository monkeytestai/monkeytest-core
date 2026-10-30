/**
 * Replay a recorded action trace without asking the LLM.
 *
 * Each step is executed from the stored locator (test id, then role+name,
 * label, placeholder, text, then the CSS fallback). `--heal` is the only
 * path that calls the model: when every recorded locator misses, the step's
 * original instruction is re-resolved and the result is marked `healed`.
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { LLM } from '../llm/index.js';
import { logModelDetail } from '../llm/coerce.js';
import type {
  FlowResult,
  FlowTrace,
  RunResult,
  StepResult,
  TestFlow,
  TestStep,
  TraceStep,
} from '../types.js';
import {
  buildLocator,
  captureLocator,
  executeAction,
  resolveAction,
  skeletonForLLM,
  type ResolvedAction,
} from './actions.js';
import { createFlowTimeout } from './timeout.js';
import { applyPassedOracles, attachStepEvidence, flushStepEvents } from './evidence.js';
import { collectOrigins, outcomeWithSameOrigin5xx, promoteRecordedSteps } from './http5xx.js';
import { resolveFlowStatus } from './flowStatus.js';

export interface ReplayOptions {
  screenshotsDir: string;
  stepTimeoutMs?: number;
  flowTimeoutMs?: number;
  headless?: boolean;
  /** Default true. Tests turn this off; video is not required to replay. */
  recordVideo?: boolean;
  /**
   * Same switch as `RunnerOptions.strictOracles`. Default false so a library
   * replay does not grow new bugs. The CLI passes true.
   */
  strictOracles?: boolean;
  /**
   * Same switch as `RunnerOptions.failOn5xx`. Default false. The CLI passes
   * the value of `--fail-on-5xx` (on unless `--no-fail-on-5xx`).
   */
  failOn5xx?: boolean;
  /**
   * Reuse a browser across calls. The caller owns its lifecycle; replay will
   * not close it. `verify` uses this so N repeats share one Chromium.
   */
  browser?: Browser;
  /**
   * When a recorded locator matches nothing, ask `llm` to re-resolve that
   * step from its original instruction. The step is marked `healed`.
   */
  heal?: boolean;
  llm?: LLM;
}

export async function replayTraces(
  traces: FlowTrace[],
  opts: ReplayOptions,
): Promise<RunResult> {
  const screenshotsDir = resolve(opts.screenshotsDir);
  mkdirSync(screenshotsDir, { recursive: true });

  const startedAt = new Date().toISOString();
  const flows: FlowResult[] = [];

  if (traces.length === 0){
    return emptyReplay(startedAt);
  }

  const owned = !opts.browser;
  const browser = opts.browser ?? await chromium.launch({ headless: opts.headless ?? true });
  try {
    for (const trace of traces){
      flows.push(await runOneTrace(browser, trace, { ...opts, screenshotsDir }));
    }
  } finally {
    if (owned) await browser.close().catch(() => {});
  }

  return {
    startUrl: traces[0]?.startUrl || '',
    startedAt,
    finishedAt: new Date().toISOString(),
    flows,
    bugs: [],
    stats: aggregate(flows),
  };
}

async function runOneTrace(
  browser: Browser,
  trace: FlowTrace,
  opts: ReplayOptions & { screenshotsDir: string },
): Promise<FlowResult> {
  const started = Date.now();
  const timeoutMs = opts.flowTimeoutMs ?? 180_000;
  const abort = new AbortController();
  const timeout = createFlowTimeout(trace.name || trace.flowId, timeoutMs, () => abort.abort());
  const work = replayFlow(browser, trace, opts, abort.signal);
  // If the timeout wins the race, replayFlow may still reject once the
  // context closes. Observe that rejection so it cannot surface later.
  work.catch(() => {});

  try {
    // `timeout.promise` rejects when the budget is hit and only resolves if
    // `cancel()` runs — which is the `finally` below, after this race.
    const winner = await Promise.race([work, timeout.promise]);
    if (!winner || !('flowId' in winner)){
      throw new Error(`flow "${trace.name || trace.flowId}" exceeded ${timeoutMs}ms`);
    }
    return winner;
  } catch (err) {
    abort.abort();
    return {
      flowId: trace.flowId,
      name: trace.name || trace.flowId,
      description: trace.description || '',
      kind: trace.kind || 'happy_path',
      startUrl: trace.startUrl,
      status: 'error',
      failureReason: err instanceof Error ? err.message : String(err),
      steps: [],
      durationMs: Date.now() - started,
      bugIds: [],
    };
  } finally {
    timeout.cancel();
  }
}

async function replayFlow(
  browser: Browser,
  trace: FlowTrace,
  opts: ReplayOptions & { screenshotsDir: string },
  signal: AbortSignal,
): Promise<FlowResult> {
  const started = Date.now();
  const stepTimeout = opts.stepTimeoutMs ?? 15_000;
  const context = await openContext(browser, opts);
  const onAbort = () => { void context.close().catch(() => {}); };
  if (signal.aborted){
    await context.close().catch(() => {});
    throw new Error('flow aborted');
  }
  signal.addEventListener('abort', onAbort, { once: true });

  const page = await context.newPage();
  const evidence = attachStepEvidence(page);
  const origins = collectOrigins([trace.startUrl]);

  const steps: StepResult[] = [];
  const traceSteps: TraceStep[] = [];
  let failed = false;
  let failureReason: string | undefined;

  try {
    for (const recorded of trace.steps){
      if (signal.aborted) throw new Error('flow aborted');
      evidence.stepIndex = recorded.index;

      if (failed){
        const blocked = blockedResult(recorded, 'Earlier step failed; not attempted.');
        blocked.screenshotPath = await shot(page, opts.screenshotsDir, trace.flowId, recorded.index, 'blocked');
        steps.push(blocked);
        continue;
      }

      const urlBefore = page.url();
      const startedAt = new Date().toISOString();
      const stepStart = Date.now();
      const played = await playStep(page, trace, recorded, opts, stepTimeout);
      if (opts.strictOracles) {
        played.outcome = await applyPassedOracles(page, evidence, recorded.index, played.outcome);
      }
      if (opts.failOn5xx) {
        if (!opts.strictOracles) await flushStepEvents(page);
        played.outcome = outcomeWithSameOrigin5xx(
          played.outcome,
          evidence.networkByStep.get(recorded.index),
          origins,
        );
      }
      const urlAfter = safeUrl(page);

      const result: StepResult = {
        index: recorded.index,
        action: recorded.action || played.action.tool,
        expectation: recorded.expectation,
        status: played.outcome.status,
        observation: played.outcome.observation,
        tool: played.action.tool,
        target: played.action.target,
        locator: played.locator,
        resolution: played.resolution,
        durationMs: Date.now() - stepStart,
        screenshotPath: await shot(page, opts.screenshotsDir, trace.flowId, recorded.index, played.outcome.status),
        consoleErrors: evidence.consoleByStep.get(recorded.index),
        networkFailures: evidence.networkByStep.get(recorded.index),
        ...(played.outcome.error ? { error: played.outcome.error } : {}),
      };
      steps.push(result);
      traceSteps.push({
        index: recorded.index,
        action: recorded.action,
        expectation: recorded.expectation,
        tool: played.action.tool as TraceStep['tool'],
        locator: played.locator,
        value: played.action.value,
        urlBefore,
        urlAfter,
        startedAt,
        durationMs: result.durationMs,
        status: result.status,
        observation: result.observation,
        error: result.error,
        screenshotPath: result.screenshotPath,
        consoleErrors: result.consoleErrors,
        networkFailures: result.networkFailures,
        resolution: played.resolution,
      });

      if (result.status === 'failed'){
        failed = true;
        failureReason = result.error || result.observation;
      }
    }
    if (opts.failOn5xx) await flushStepEvents(page);
  } finally {
    signal.removeEventListener('abort', onAbort);
    await context.close().catch(() => {});
  }

  if (opts.failOn5xx) {
    const promoted = promoteRecordedSteps(steps, traceSteps, origins);
    if (promoted.changed) {
      steps.splice(0, steps.length, ...promoted.steps);
      traceSteps.splice(0, traceSteps.length, ...promoted.traceSteps);
      if (promoted.failed) {
        failed = true;
        failureReason = failureReason || promoted.failureReason;
      }
    }
  }

  const status = resolveFlowStatus(steps, failed);
  return {
    flowId: trace.flowId,
    name: trace.name || trace.flowId,
    description: trace.description || '',
    kind: trace.kind || 'happy_path',
    startUrl: trace.startUrl,
    status,
    failureReason,
    steps,
    durationMs: Date.now() - started,
    bugIds: [],
    trace: {
      version: 1,
      flowId: trace.flowId,
      name: trace.name || trace.flowId,
      description: trace.description,
      kind: trace.kind,
      startUrl: trace.startUrl,
      expectation: trace.expectation,
      steps: traceSteps,
    },
  };
}

interface PlayedStep {
  action: ResolvedAction;
  locator: TraceStep['locator'];
  outcome: Awaited<ReturnType<typeof executeAction>>;
  resolution: 'recorded' | 'healed';
}

async function playStep(
  page: Page,
  trace: FlowTrace,
  recorded: TraceStep,
  opts: ReplayOptions,
  timeoutMs: number,
): Promise<PlayedStep> {
  if (!needsElement(recorded)){
    const action = actionFromRecorded(recorded);
    const outcome = await executeAction(page, action, timeoutMs, { strictOracles: opts.strictOracles });
    return { action, locator: recorded.locator, outcome, resolution: 'recorded' };
  }

  const matched = await firstMatch(page, recorded);
  if (matched){
    const outcome = await executeAction(page, matched, timeoutMs, { strictOracles: opts.strictOracles });
    const locator = await captureLocator(page, matched).catch(() => recorded.locator);
    return { action: matched, locator: locator || recorded.locator, outcome, resolution: 'recorded' };
  }

  if (opts.heal && opts.llm && recorded.action){
    let healed: ResolvedAction;
    try {
      healed = await healStep(page, trace, recorded, opts.llm);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logModelDetail('runner.resolveAction', detail);
      return {
        action: actionFromRecorded(recorded),
        locator: recorded.locator,
        resolution: 'recorded',
        outcome: {
          status: 'failed',
          observation: 'Recorded locator no longer matches, and the model could not propose a replacement.',
          error: 'locator_mismatch',
        },
      };
    }
    const outcome = await executeAction(page, healed, timeoutMs, { strictOracles: opts.strictOracles });
    const locator = await captureLocator(page, healed).catch(() => undefined);
    return {
      action: healed,
      locator,
      outcome: {
        ...outcome,
        observation: `Healed (recorded locator missed). ${outcome.observation}`,
      },
      resolution: 'healed',
    };
  }

  // The original run already continued past this step. A locator miss here
  // must not become a hard failure, or verify never reaches the later bug
  // (a placeholder fill that timed out, then a form POST that returned 500).
  // A step that originally passed or failed still stops the flow.
  if (recorded.status === 'skipped'){
    return {
      action: actionFromRecorded(recorded),
      locator: recorded.locator,
      resolution: 'recorded',
      outcome: {
        status: 'skipped',
        observation: `Recorded step was skipped and its locator still does not match for ${recorded.tool} (${describeLocator(recorded)}). Left skipped so later steps still run.`,
      },
    };
  }

  return {
    action: actionFromRecorded(recorded),
    locator: recorded.locator,
    resolution: 'recorded',
    outcome: {
      status: 'failed',
      observation: `Recorded locator no longer matches for ${recorded.tool} (${describeLocator(recorded)}).`,
      error: 'locator_mismatch',
    },
  };
}

async function healStep(
  page: Page,
  trace: FlowTrace,
  recorded: TraceStep,
  llm: LLM,
): Promise<ResolvedAction> {
  const flow: TestFlow = {
    id: trace.flowId,
    name: trace.name || trace.flowId,
    description: trace.description || '',
    kind: trace.kind || 'happy_path',
    startUrl: trace.startUrl,
    expectation: trace.expectation || '',
    severityIfFails: 'major',
    steps: trace.steps
      .filter(step => step.action)
      .map(step => ({ action: step.action!, expectation: step.expectation })),
  };
  const step: TestStep = { action: recorded.action || '', expectation: recorded.expectation };
  const skeleton = await skeletonForLLM(page);
  return resolveAction(llm, flow, step, skeleton);
}

function needsElement(step: TraceStep): boolean {
  if (step.tool === 'goto' || step.tool === 'noop' || step.tool === 'assert_text') return false;
  if (step.tool === 'press' && !step.locator) return false;
  return true;
}

function actionFromRecorded(step: TraceStep): ResolvedAction {
  if (step.tool === 'goto'){
    return { tool: 'goto', target: step.locator?.target || step.urlAfter || '' };
  }
  if (step.tool === 'assert_text'){
    return { tool: 'assert_text', target: step.locator?.target || step.action };
  }
  if (step.tool === 'noop'){
    return { tool: 'noop', rationale: step.observation };
  }
  if (step.tool === 'press' && !step.locator){
    return { tool: 'press', value: step.value };
  }
  const locator = step.locator;
  return {
    tool: step.tool,
    locator: locator?.strategy === 'testid' ? 'testid' : (locator?.strategy || 'css'),
    target: locator?.target || '',
    value: step.value,
  };
}

async function firstMatch(page: Page, step: TraceStep): Promise<ResolvedAction | null> {
  const locator = step.locator;
  if (!locator) return null;

  const candidates: ResolvedAction[] = [];
  const push = (action: ResolvedAction) => {
    const key = `${action.locator}|${action.target}`;
    if (candidates.some(existing => `${existing.locator}|${existing.target}` === key)) return;
    candidates.push(action);
  };

  if (locator.testId) push({ tool: step.tool, locator: 'testid', target: locator.testId, value: step.value });
  if (locator.role && (locator.name || locator.target)){
    const name = locator.name || locator.target;
    push({ tool: step.tool, locator: 'role', target: `${locator.role}:${name}`, value: step.value });
  }
  if (locator.label) push({ tool: step.tool, locator: 'label', target: locator.label, value: step.value });
  if (locator.placeholder) push({ tool: step.tool, locator: 'placeholder', target: locator.placeholder, value: step.value });
  if (locator.text) push({ tool: step.tool, locator: 'text', target: locator.text, value: step.value });
  if (locator.css) push({ tool: step.tool, locator: 'css', target: locator.css, value: step.value });
  if (locator.strategy === 'css' && locator.target && locator.target !== locator.css){
    push({ tool: step.tool, locator: 'css', target: locator.target, value: step.value });
  }
  if (locator.strategy && locator.strategy !== 'css' && locator.target){
    push({
      tool: step.tool,
      locator: locator.strategy,
      target: locator.strategy === 'role' && locator.role && locator.name
        ? `${locator.role}:${locator.name}`
        : locator.target,
      value: step.value,
    });
  }

  for (const candidate of candidates){
    try {
      const count = await buildLocator(page, candidate).count();
      if (count > 0) return candidate;
    } catch {
      /* a stale CSS selector can throw on parse; try the next candidate */
    }
  }
  return null;
}

function describeLocator(step: TraceStep): string {
  const locator = step.locator;
  if (!locator) return 'no locator';
  const bits = [
    locator.testId && `testid=${locator.testId}`,
    locator.role && `role=${locator.role}`,
    locator.name && `name=${locator.name}`,
    locator.css && `css=${locator.css}`,
  ].filter(Boolean);
  return bits.join(' ') || `${locator.strategy}:${locator.target}`;
}

function blockedResult(recorded: TraceStep, observation: string): StepResult {
  return {
    index: recorded.index,
    action: recorded.action || recorded.tool,
    expectation: recorded.expectation,
    status: 'blocked',
    observation,
    resolution: 'recorded',
  };
}

async function openContext(browser: Browser, opts: ReplayOptions & { screenshotsDir: string }): Promise<BrowserContext> {
  return browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/537.36 '
      + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 monkeytest.ai',
    viewport: { width: 1280, height: 800 },
    ...(opts.recordVideo === false ? {} : {
      recordVideo: { dir: opts.screenshotsDir, size: { width: 1280, height: 800 } },
    }),
  });
}

async function shot(
  page: Page,
  dir: string,
  flowId: string,
  index: number,
  status: string,
): Promise<string | undefined> {
  const filename = `replay-${slug(flowId)}-step-${String(index).padStart(2, '0')}-${status}.png`;
  const fullPath = join(dir, filename);
  try {
    await page.screenshot({ path: fullPath, fullPage: false });
    return fullPath;
  } catch {
    return undefined;
  }
}

function safeUrl(page: Page): string | undefined {
  try { return page.url(); }
  catch { return undefined; }
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'flow';
}

function aggregate(flows: FlowResult[]): RunResult['stats'] {
  let stepsTotal = 0, stepsPassed = 0, stepsFailed = 0;
  for (const flow of flows){
    for (const step of flow.steps){
      stepsTotal++;
      if (step.status === 'passed') stepsPassed++;
      if (step.status === 'failed') stepsFailed++;
    }
  }
  return {
    flowsTotal: flows.length,
    flowsPassed: flows.filter(flow => flow.status === 'passed').length,
    flowsFailed: flows.filter(flow => flow.status === 'failed' || flow.status === 'error').length,
    flowsBlocked: flows.filter(flow => flow.status === 'blocked').length,
    flowsInconclusive: flows.filter(flow => flow.status === 'inconclusive').length,
    stepsTotal, stepsPassed, stepsFailed,
    bugsCritical: 0, bugsMajor: 0, bugsMinor: 0,
  };
}

function emptyReplay(startedAt: string): RunResult {
  return {
    startUrl: '',
    startedAt,
    finishedAt: new Date().toISOString(),
    flows: [],
    bugs: [],
    stats: {
      flowsTotal: 0, flowsPassed: 0, flowsFailed: 0, flowsBlocked: 0, flowsInconclusive: 0,
      stepsTotal: 0, stepsPassed: 0, stepsFailed: 0,
      bugsCritical: 0, bugsMajor: 0, bugsMinor: 0,
    },
  };
}
