/**
 * Runner phase
 *
 * Executes a TestPlan in a real Chromium browser, step by step. For each step:
 *
 *   1. Ask the LLM to translate the natural-language instruction into a
 *      concrete tool call: { tool, target, value? }. The DOM skeleton of the
 *      *current* page is given as context so the model can pick a real
 *      selector (or fall back to text-based locators).
 *   2. Execute the tool. Catch every error so a single broken step never
 *      crashes the whole run.
 *   3. Take a screenshot AFTER the attempt (failed steps are screenshotted
 *      too — the failure screenshot is the most valuable thing for a human
 *      reviewer).
 *   4. Record a StepResult and emit live events for the SSE stream.
 *
 * Once a step `failed`, all remaining steps in that flow are recorded as
 * `blocked` rather than attempted — this matches the behaviour humans
 * intuitively expect from a test report timeline.
 *
 * The runner does NOT do any LLM-driven flailing: it executes the literal
 * plan steps. The exploratory / adversarial behaviour (random monkey, fuzz
 * testing) is intentionally out of scope here — the philosophy is that the
 * planner already chose what to test; the runner just executes it
 * deterministically and reports.
 */

import { chromium, type Browser, type Page } from 'playwright';
import { mkdirSync, renameSync, existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { LLM } from '../llm/index.js';
import type {
  TestPlan,
  TestFlow,
  TestStep,
  FlowResult,
  StepResult,
  StepStatus,
  RunResult,
  TraceStep,
} from '../types.js';
import { type EventBus, noopBus } from '../events.js';
import {
  captureLocator,
  executeAction,
  resolveAction,
  settleSPA,
  skeletonForLLM,
  type ResolvedAction,
} from './actions.js';
import { createFlowTimeout } from './timeout.js';
import { applyPassedOracles, attachStepEvidence } from './evidence.js';
import { serializeTrace, serializeTraceStep } from '../trace/serialize.js';

export interface RunnerOptions {
  /**
   * Where to save per-step screenshots AND per-flow videos. The runner creates
   * the directory if needed.
   * Screenshots: `flow-<flowId>-step-<n>-<status>.png`
   * Videos:      `flow-<flowId>.webm`
   */
  screenshotsDir: string;
  /** Per-step navigation/action timeout. Default 15s. */
  stepTimeoutMs?: number;
  /** Hard cap on a flow's wall-clock time. Default 180s. */
  flowTimeoutMs?: number;
  /** Launch the browser headless. Default true. */
  headless?: boolean;
  /**
   * Record a WebM per flow. Default true. Replay and tests can turn this off;
   * the action trace does not depend on it.
   */
  recordVideo?: boolean;
  /** Hook for live progress events (legacy callback API). */
  onEvent?: (event: RunnerEvent) => void;
  /** Optional live event bus. Receives runner lifecycle events. */
  events?: EventBus;
}

export type RunnerEvent =
  | { type: 'flow.start';    flowId: string;            flow: TestFlow }
  | { type: 'step.start';    flowId: string; index: number; step: TestStep }
  | { type: 'step.complete'; flowId: string; index: number; result: StepResult }
  | { type: 'flow.complete'; flowId: string; result: FlowResult };

/* ── Public entry point ───────────────────────────────────────────────── */

export async function runPlan(
  plan: TestPlan,
  llm: LLM,
  opts: RunnerOptions,
): Promise<RunResult> {

  const screenshotsDir = resolve(opts.screenshotsDir);
  mkdirSync(screenshotsDir, { recursive: true });

  const stepTimeout = opts.stepTimeoutMs ?? 15_000;
  const flowTimeout = opts.flowTimeoutMs ?? 180_000;
  const headless    = opts.headless ?? true;
  const events      = opts.events ?? noopBus();

  const startedAt = new Date().toISOString();
  const flows: FlowResult[] = [];

  if (plan.flows.length === 0){
    return emptyRun(plan, startedAt);
  }

  const browser = await chromium.launch({ headless });

  try {

    for (let fi = 0; fi < plan.flows.length; fi++){

      const flow = plan.flows[fi];

      // auth_required flows aren't currently runnable — record a neat
      // "blocked: needs credentials" entry instead of erroring out.
      if (flow.kind === 'auth_required'){
        const skipped = skippedFlowResult(flow, 'Skipped: this journey needs an account. Login-path testing is available on Chimp and Gorilla plans.');
        flows.push(skipped);
        opts.onEvent?.({ type: 'flow.complete', flowId: flow.id, result: skipped });
        events.emit({
          phase: 'runner', type: 'run.flow_complete',
          message: `Flow ${fi + 1}/${plan.flows.length} skipped (needs auth): ${flow.name}`,
          data: { flowId: flow.id, flowIndex: fi + 1, flowsTotal: plan.flows.length, status: skipped.status },
        });
        continue;
      }

      opts.onEvent?.({ type: 'flow.start', flowId: flow.id, flow });
      events.emit({
        phase: 'runner', type: 'run.flow_start',
        message: `Flow ${fi + 1}/${plan.flows.length}: ${flow.name}`,
        data: {
          flowId: flow.id,
          flowIndex: fi + 1,
          flowsTotal: plan.flows.length,
          name: flow.name,
          kind: flow.kind,
          startUrl: flow.startUrl,
          stepsTotal: flow.steps.length,
        },
      });

      const flowStarted = Date.now();
      const abort = new AbortController();
      // Firing the guard aborts the context immediately; cancel() after the
      // race clears the timer so a finished flow cannot reject later.
      const timeout = createFlowTimeout(flow.name, flowTimeout, () => abort.abort());
      const work = runFlow(
        browser, flow, llm,
        { ...opts, screenshotsDir, stepTimeoutMs: stepTimeout, events },
        fi + 1, plan.flows.length,
        abort.signal,
      );
      work.catch(() => {});

      let result: FlowResult;
      try {
        const winner = await Promise.race([work, timeout.promise]);
        if (!winner || !('flowId' in winner)){
          throw new Error(`flow "${flow.name}" exceeded ${flowTimeout}ms`);
        }
        result = winner;
      } catch (err) {
        abort.abort();
        result = errorFlowResult(flow, err instanceof Error ? err.message : String(err), flowStarted);
      } finally {
        timeout.cancel();
      }

      flows.push(result);
      opts.onEvent?.({ type: 'flow.complete', flowId: flow.id, result });
      events.emit({
        phase: 'runner', type: 'run.flow_complete',
        message: `Flow ${fi + 1}/${plan.flows.length} ${result.status}: ${flow.name}`,
        data: {
          flowId: flow.id,
          flowIndex: fi + 1,
          flowsTotal: plan.flows.length,
          status: result.status,
          failureReason: result.failureReason || null,
        },
      });

    }

  } finally {
    await browser.close().catch(() => {});
  }

  const finishedAt = new Date().toISOString();
  return {
    startUrl: plan.startUrl,
    startedAt,
    finishedAt,
    flows,
    bugs: [],                                   // populated by triager phase
    stats: aggregateStats(flows),
  };

}

/* ── Single-flow execution ────────────────────────────────────────────── */

interface RunFlowOpts extends RunnerOptions {
  screenshotsDir: string;
  stepTimeoutMs: number;
  events: EventBus;
}

async function runFlow(
  browser: Browser,
  flow: TestFlow,
  llm: LLM,
  opts: RunFlowOpts,
  flowIndex: number,
  flowsTotal: number,
  signal?: AbortSignal,
): Promise<FlowResult> {

  const events = opts.events;

  const flowStarted = Date.now();

  // Playwright records one WebM video per BrowserContext. It saves to a temp
  // UUID filename in `screenshotsDir`; we rename it to a predictable basename
  // after context.close() resolves. The video covers the entire flow from the
  // first navigation to the final screenshot — exactly what you'd want to
  // replay when a test fails.
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/537.36 '
      + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 monkeytest.ai',
    viewport: { width: 1280, height: 800 },
    ...(opts.recordVideo === false ? {} : {
      recordVideo: {
        dir: opts.screenshotsDir,
        size: { width: 1280, height: 800 },
      },
    }),
  });

  const onAbort = () => { void context.close().catch(() => {}); };
  if (signal?.aborted){
    await context.close().catch(() => {});
    throw new Error('flow aborted');
  }
  signal?.addEventListener('abort', onAbort, { once: true });

  const page = await context.newPage();

  // Per-flow buffers. Listeners attribute console, page errors, and network
  // failures to whichever step index is current.
  const evidence = attachStepEvidence(page);

  const steps: StepResult[] = [];
  const traceSteps: TraceStep[] = [];
  let flowFailed = false;
  let firstFailureReason: string | undefined;

  const finish = (videoPath?: string) => finaliseFlow(
    flow, steps, flowFailed, firstFailureReason, flowStarted, videoPath, traceSteps,
  );

  // 1. Initial navigation. Implicit "step 0" — if this fails, the whole
  //    flow is blocked before we even attempt the planned steps. The goto is
  //    part of the trace either way so replay can repeat it without the LLM.
  const navStarted = Date.now();
  const navStartedAt = new Date().toISOString();
  let navOracleError: string | undefined;
  try {
    evidence.stepIndex = 0;
    await page.goto(flow.startUrl, { waitUntil: 'domcontentloaded', timeout: opts.stepTimeoutMs });
    await settleSPA(page);
    const nav = await applyPassedOracles(page, evidence, 0, {
      status: 'passed',
      observation: `Navigated to ${flow.startUrl}.`,
    });
    if (nav.status === 'failed') {
      navOracleError = nav.error || nav.observation;
      throw new Error(navOracleError);
    }
    traceSteps.push(serializeTraceStep({
      index: 0,
      action: `Open ${flow.startUrl}`,
      tool: 'goto',
      locator: { strategy: 'css', target: flow.startUrl },
      urlAfter: page.url(),
      startedAt: navStartedAt,
      durationMs: Date.now() - navStarted,
      status: 'passed',
      observation: `Navigated to ${flow.startUrl}.`,
      resolution: 'recorded',
    }));
  } catch (err) {
    const msg = navOracleError || (err instanceof Error ? err.message : String(err));
    const blockingStep: StepResult = {
      index: 0,
      action: `Open ${flow.startUrl}`,
      status: 'failed',
      observation: navOracleError
        ? `Opening ${flow.startUrl} failed: ${msg}.`
        : `Could not load the starting page (${msg}).`,
      tool: 'goto',
      target: flow.startUrl,
      error: msg,
      screenshotPath: await safeShot(page, opts.screenshotsDir, flow.id, 0, 'failed'),
      consoleErrors: evidence.consoleByStep.get(0),
      networkFailures: evidence.networkByStep.get(0),
    };
    steps.push(blockingStep);
    traceSteps.push(serializeTraceStep({
      index: 0,
      action: blockingStep.action,
      tool: 'goto',
      locator: { strategy: 'css', target: flow.startUrl },
      startedAt: navStartedAt,
      durationMs: Date.now() - navStarted,
      status: 'failed',
      observation: blockingStep.observation,
      error: msg,
      screenshotPath: blockingStep.screenshotPath,
      consoleErrors: blockingStep.consoleErrors,
      networkFailures: blockingStep.networkFailures,
      resolution: 'recorded',
    }));
    flowFailed = true;
    firstFailureReason = msg;
    if (blockingStep.screenshotPath){
      events.emit({
        phase: 'runner', type: 'run.screenshot',
        message: `Screenshot captured (step 0 failed)`,
        data: {
          flowId: flow.id, flowIndex, flowsTotal,
          stepIndex: 0, status: 'failed',
          screenshot: basename(blockingStep.screenshotPath),
        },
      });
    }
    // Record the rest as blocked with screenshots too — evidence should be
    // visible for every planned step, even when navigation failed early.
    for (let i = 0; i < flow.steps.length; i++){
      const blocked = blockedStep(i + 1, flow.steps[i], 'Earlier step failed; not attempted.');
      blocked.screenshotPath = await safeShot(page, opts.screenshotsDir, flow.id, i + 1, 'blocked');
      steps.push(blocked);
    }
    signal?.removeEventListener('abort', onAbort);
    await context.close().catch(() => {});
    return finish();
  }

  // 2. Walk the planned steps.
  for (let i = 0; i < flow.steps.length; i++){
    const stepIndex = i + 1;
    evidence.stepIndex = stepIndex;
    const step = flow.steps[i];

    opts.onEvent?.({ type: 'step.start', flowId: flow.id, index: stepIndex, step });
    events.emit({
      phase: 'runner', type: 'run.step_start',
      message: `Step ${stepIndex}/${flow.steps.length}: ${truncate(step.action, 90)}`,
      data: {
        flowId: flow.id, flowIndex, flowsTotal,
        stepIndex, stepsTotal: flow.steps.length,
        action: step.action,
        currentUrl: page.url(),
      },
    });

    if (flowFailed){
      const blocked = blockedStep(stepIndex, step, 'Earlier step failed; not attempted.');
      blocked.screenshotPath = await safeShot(page, opts.screenshotsDir, flow.id, stepIndex, 'blocked');
      steps.push(blocked);
      opts.onEvent?.({ type: 'step.complete', flowId: flow.id, index: stepIndex, result: blocked });
      events.emit({
        phase: 'runner', type: 'run.step_complete',
        message: `Step ${stepIndex} blocked (earlier step failed)`,
        data: {
          flowId: flow.id, flowIndex, flowsTotal,
          stepIndex, status: 'blocked',
          screenshot: blocked.screenshotPath ? basename(blocked.screenshotPath) : null,
        },
      });
      continue;
    }

    if (signal?.aborted){
      signal.removeEventListener('abort', onAbort);
      throw new Error('flow aborted');
    }

    const stepStart = Date.now();
    const startedAt = new Date().toISOString();
    const urlBefore = page.url();
    let resolved: ResolvedAction;
    try {
      const skeleton = await skeletonForLLM(page);
      resolved = await resolveAction(llm, flow, step, skeleton);
    } catch (err) {
      // LLM couldn't propose an action. That's a planner/runner integration
      // problem, not a product bug — record it but don't poison the flow.
      const msg = err instanceof Error ? err.message : String(err);
      const result: StepResult = {
        index: stepIndex,
        action: step.action,
        expectation: step.expectation,
        status: 'skipped',
        observation: `Could not interpret this step automatically (${msg.slice(0, 120)}).`,
        durationMs: Date.now() - stepStart,
        screenshotPath: await safeShot(page, opts.screenshotsDir, flow.id, stepIndex, 'skipped'),
      };
      steps.push(result);
      traceSteps.push(serializeTraceStep({
        index: stepIndex,
        action: step.action,
        expectation: step.expectation,
        tool: 'noop',
        urlBefore,
        urlAfter: safePageUrl(page),
        startedAt,
        durationMs: result.durationMs,
        status: 'skipped',
        observation: result.observation,
        screenshotPath: result.screenshotPath,
        resolution: 'recorded',
      }));
      opts.onEvent?.({ type: 'step.complete', flowId: flow.id, index: stepIndex, result });
      events.emit({
        phase: 'runner', type: 'run.step_complete',
        message: `Step ${stepIndex} skipped: could not interpret`,
        data: {
          flowId: flow.id, flowIndex, flowsTotal,
          stepIndex, status: result.status,
          observation: result.observation,
          screenshot: result.screenshotPath ? basename(result.screenshotPath) : null,
          currentUrl: page.url(),
        },
      });
      continue;
    }

    const locator = await captureLocator(page, resolved);
    const exec = await applyPassedOracles(
      page,
      evidence,
      stepIndex,
      await executeAction(page, resolved, opts.stepTimeoutMs),
    );
    const screenshotPath = await safeShot(page, opts.screenshotsDir, flow.id, stepIndex, exec.status);
    const durationMs = Date.now() - stepStart;

    const result: StepResult = {
      index: stepIndex,
      action: step.action,
      expectation: step.expectation,
      status: exec.status,
      observation: exec.observation,
      tool: resolved.tool,
      target: resolved.target,
      locator,
      resolution: 'recorded',
      durationMs,
      screenshotPath,
      consoleErrors: evidence.consoleByStep.get(stepIndex),
      networkFailures: evidence.networkByStep.get(stepIndex),
      ...(exec.error ? { error: exec.error } : {}),
    };
    steps.push(result);
    traceSteps.push(serializeTraceStep({
      index: stepIndex,
      action: step.action,
      expectation: step.expectation,
      tool: resolved.tool,
      locator,
      value: resolved.value,
      urlBefore,
      urlAfter: safePageUrl(page),
      startedAt,
      durationMs,
      status: exec.status,
      observation: exec.observation,
      error: exec.error,
      screenshotPath,
      consoleErrors: result.consoleErrors,
      networkFailures: result.networkFailures,
      resolution: 'recorded',
    }));
    opts.onEvent?.({ type: 'step.complete', flowId: flow.id, index: stepIndex, result });
    events.emit({
      phase: 'runner', type: 'run.step_complete',
      message: `Step ${stepIndex} ${exec.status}: ${truncate(exec.observation, 100)}`,
      data: {
        flowId: flow.id, flowIndex, flowsTotal,
        stepIndex, stepsTotal: flow.steps.length,
        status: exec.status,
        tool: resolved.tool,
        observation: exec.observation,
        screenshot: screenshotPath ? basename(screenshotPath) : null,
        currentUrl: page.url(),
        durationMs: result.durationMs,
      },
    });

    if (exec.status === 'failed'){
      flowFailed = true;
      firstFailureReason = firstFailureReason || exec.error || exec.observation;
    }
  }

  // Grab the video path before closing — Playwright finalises the file on close.
  let videoPathRaw: string | null = null;
  try {
    videoPathRaw = await page.video()?.path() ?? null;
  } catch { /* page already closed */ }

  signal?.removeEventListener('abort', onAbort);
  await context.close().catch(() => {});

  // Rename UUID video file → predictable flow-level basename so we can
  // construct a serve URL without a manifest.
  let videoPath: string | undefined;
  if (opts.recordVideo !== false && videoPathRaw && existsSync(videoPathRaw)){
    const dest = join(opts.screenshotsDir, `flow-${slug(flow.id)}.webm`);
    try {
      renameSync(videoPathRaw, dest);
      videoPath = dest;
    } catch {
      videoPath = videoPathRaw;   // fallback: keep the UUID name
    }
  } else if (opts.recordVideo !== false) {
    // page.video().path() sometimes returns the path before the file exists;
    // scan the dir for any .webm that's newer than the flow start time.
    try {
      const dir = opts.screenshotsDir;
      const candidate = readdirSync(dir)
        .filter(f => f.endsWith('.webm'))
        .map(f => ({ f, mtime: existsSync(join(dir, f)) ? statSync(join(dir, f)).mtimeMs : 0 }))
        .sort((a, b) => b.mtime - a.mtime)[0];
      if (candidate){
        const dest = join(opts.screenshotsDir, `flow-${slug(flow.id)}.webm`);
        renameSync(join(dir, candidate.f), dest);
        videoPath = dest;
      }
    } catch { /* ignore */ }
  }

  return finish(videoPath);

}

/* ── Helpers ──────────────────────────────────────────────────────────── */


async function safeShot(
  page: Page,
  dir: string,
  flowId: string,
  index: number,
  status: StepStatus,
): Promise<string | undefined> {

  const filename = `flow-${slug(flowId)}-step-${String(index).padStart(2, '0')}-${status}.png`;
  const fullPath = join(dir, filename);
  try {
    await page.screenshot({ path: fullPath, fullPage: false });
    return fullPath;
  } catch {
    return undefined;
  }

}

function blockedStep(index: number, step: TestStep, observation: string): StepResult {
  return {
    index,
    action: step.action,
    expectation: step.expectation,
    status: 'blocked',
    observation,
  };
}

function skippedFlowResult(flow: TestFlow, reason: string): FlowResult {
  return {
    flowId: flow.id,
    name: flow.name,
    description: flow.description,
    kind: flow.kind,
    startUrl: flow.startUrl,
    status: 'blocked',
    failureReason: reason,
    steps: flow.steps.map((s, i) => blockedStep(i + 1, s, reason)),
    durationMs: 0,
    bugIds: [],
  };
}

function errorFlowResult(flow: TestFlow, msg: string, started: number): FlowResult {
  return {
    flowId: flow.id,
    name: flow.name,
    description: flow.description,
    kind: flow.kind,
    startUrl: flow.startUrl,
    status: 'error',
    failureReason: msg,
    steps: flow.steps.map((s, i) => blockedStep(i + 1, s, 'Flow aborted before this step.')),
    durationMs: Date.now() - started,
    bugIds: [],
  };
}

function finaliseFlow(
  flow: TestFlow,
  steps: StepResult[],
  failed: boolean,
  failureReason: string | undefined,
  started: number,
  videoPath: string | undefined,
  traceSteps: TraceStep[],
): FlowResult {

  const status: FlowResult['status'] = failed ? 'failed' : 'passed';
  const trace = serializeTrace({
    version: 1,
    flowId: flow.id,
    name: flow.name,
    description: flow.description,
    kind: flow.kind,
    startUrl: flow.startUrl,
    expectation: flow.expectation,
    steps: traceSteps,
  });

  return {
    flowId: flow.id,
    name: flow.name,
    description: flow.description,
    kind: flow.kind,
    startUrl: flow.startUrl,
    status,
    failureReason,
    steps,
    durationMs: Date.now() - started,
    bugIds: [],                                  // populated by triager
    ...(videoPath ? { videoPath } : {}),
    trace,
  };

}

function emptyRun(plan: TestPlan, startedAt: string): RunResult {
  return {
    startUrl: plan.startUrl,
    startedAt,
    finishedAt: new Date().toISOString(),
    flows: [],
    bugs: [],
    stats: {
      flowsTotal: 0, flowsPassed: 0, flowsFailed: 0, flowsBlocked: 0,
      stepsTotal: 0, stepsPassed: 0, stepsFailed: 0,
      bugsCritical: 0, bugsMajor: 0, bugsMinor: 0,
    },
  };
}

function aggregateStats(flows: FlowResult[]): RunResult['stats'] {
  let stepsTotal = 0, stepsPassed = 0, stepsFailed = 0;
  for (const f of flows){
    for (const s of f.steps){
      stepsTotal++;
      if (s.status === 'passed') stepsPassed++;
      if (s.status === 'failed') stepsFailed++;
    }
  }
  return {
    flowsTotal: flows.length,
    flowsPassed: flows.filter(f => f.status === 'passed').length,
    flowsFailed: flows.filter(f => f.status === 'failed' || f.status === 'error').length,
    flowsBlocked: flows.filter(f => f.status === 'blocked').length,
    stepsTotal, stepsPassed, stepsFailed,
    bugsCritical: 0, bugsMajor: 0, bugsMinor: 0, // filled in by the triager
  };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function safePageUrl(page: Page): string | undefined {
  try { return page.url(); }
  catch { return undefined; }
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'flow';
}
