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

import { chromium, type Browser, type BrowserContext, type Page, type ConsoleMessage, type Request } from 'playwright';
import { mkdirSync, renameSync, existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { z } from 'zod';
import type { LLM } from '../llm/index.js';
import type {
  TestPlan,
  TestFlow,
  TestStep,
  FlowResult,
  StepResult,
  StepStatus,
  RunResult,
  ConsoleErrorEvidence,
  NetworkFailureEvidence,
} from '../types.js';
import { type EventBus, noopBus } from '../events.js';

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
        const skipped = skippedFlowResult(flow, 'Skipped: flow requires credentials we do not have.');
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

      let result: FlowResult;
      try {
        result = await Promise.race([
          runFlow(browser, flow, llm, { ...opts, screenshotsDir, stepTimeoutMs: stepTimeout, events }, fi + 1, plan.flows.length),
          flowTimeoutGuard(flow, flowTimeout, flowStarted),
        ]);
      } catch (err) {
        result = errorFlowResult(flow, err instanceof Error ? err.message : String(err), flowStarted);
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
    recordVideo: {
      dir: opts.screenshotsDir,
      size: { width: 1280, height: 800 },
    },
  });

  const page = await context.newPage();

  // Per-flow buffers. We attribute console errors / network failures to the
  // step that was running when they fired — see `currentStepIndex`.
  let currentStepIndex = 0;
  const consoleByStep: Map<number, ConsoleErrorEvidence[]> = new Map();
  const networkByStep: Map<number, NetworkFailureEvidence[]> = new Map();

  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() !== 'error' && msg.type() !== 'warning') return;
    const arr = consoleByStep.get(currentStepIndex) ?? [];
    arr.push({
      message: msg.text().slice(0, 500),
      level: msg.type() === 'error' ? 'error' : 'warning',
      url: msg.location()?.url,
      lineNumber: msg.location()?.lineNumber,
    });
    consoleByStep.set(currentStepIndex, arr);
  });

  page.on('requestfailed', (req: Request) => {
    // Ignore the noise — websockets and dev-server pings break constantly
    // and would drown out the real signal.
    if (req.url().startsWith('ws:') || req.url().startsWith('wss:')) return;
    const arr = networkByStep.get(currentStepIndex) ?? [];
    arr.push({
      url: req.url(),
      method: req.method(),
      failureText: req.failure()?.errorText,
    });
    networkByStep.set(currentStepIndex, arr);
  });

  page.on('response', (res) => {
    const status = res.status();
    if (status < 500) return;
    const arr = networkByStep.get(currentStepIndex) ?? [];
    arr.push({
      url: res.url(),
      method: res.request().method(),
      status,
    });
    networkByStep.set(currentStepIndex, arr);
  });

  const steps: StepResult[] = [];
  let flowFailed = false;
  let firstFailureReason: string | undefined;

  // 1. Initial navigation. Implicit "step 0" — if this fails, the whole
  //    flow is blocked before we even attempt the planned steps.
  try {
    await page.goto(flow.startUrl, { waitUntil: 'domcontentloaded', timeout: opts.stepTimeoutMs });
    await settleSPA(page);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const blockingStep: StepResult = {
      index: 0,
      action: `Open ${flow.startUrl}`,
      status: 'failed',
      observation: `Could not load the starting page (${msg}).`,
      tool: 'goto',
      target: flow.startUrl,
      error: msg,
      screenshotPath: await safeShot(page, opts.screenshotsDir, flow.id, 0, 'failed'),
    };
    steps.push(blockingStep);
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
    await context.close().catch(() => {});
    return finaliseFlow(flow, steps, flowFailed, firstFailureReason, flowStarted);
  }

  // 2. Walk the planned steps.
  for (let i = 0; i < flow.steps.length; i++){
    const stepIndex = i + 1;
    currentStepIndex = stepIndex;
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

    const stepStart = Date.now();
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

    const exec = await executeAction(page, resolved, opts.stepTimeoutMs);
    const screenshotPath = await safeShot(page, opts.screenshotsDir, flow.id, stepIndex, exec.status);

    const result: StepResult = {
      index: stepIndex,
      action: step.action,
      expectation: step.expectation,
      status: exec.status,
      observation: exec.observation,
      tool: resolved.tool,
      target: resolved.target,
      durationMs: Date.now() - stepStart,
      screenshotPath,
      consoleErrors: consoleByStep.get(stepIndex),
      networkFailures: networkByStep.get(stepIndex),
      ...(exec.error ? { error: exec.error } : {}),
    };
    steps.push(result);
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

  await context.close().catch(() => {});

  // Rename UUID video file → predictable flow-level basename so we can
  // construct a serve URL without a manifest.
  let videoPath: string | undefined;
  if (videoPathRaw && existsSync(videoPathRaw)){
    const dest = join(opts.screenshotsDir, `flow-${slug(flow.id)}.webm`);
    try {
      renameSync(videoPathRaw, dest);
      videoPath = dest;
    } catch {
      videoPath = videoPathRaw;   // fallback: keep the UUID name
    }
  } else {
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

  return finaliseFlow(flow, steps, flowFailed, firstFailureReason, flowStarted, videoPath);

}

/* ── LLM: translate natural-language step → concrete action ──────────── */

const ActionSchema = z.object({
  tool: z.enum(['click', 'fill', 'goto', 'wait', 'assert_text', 'press', 'noop']),
  /** CSS selector, URL (for goto), or text snippet (for assert_text). */
  target: z.string().optional(),
  /** Value to type (for fill) or key chord (for press). */
  value: z.string().optional(),
  /** Locator strategy hint. Used to fall back to role/text locators when
   *  CSS selectors are flaky. */
  locator: z.enum(['css', 'role', 'text', 'placeholder', 'label']).optional(),
  /** One-sentence explanation, useful for the report timeline. */
  rationale: z.string().optional(),
});

type ResolvedAction = z.infer<typeof ActionSchema>;

async function resolveAction(
  llm: LLM,
  flow: TestFlow,
  step: TestStep,
  skeleton: PageSkeletonForLLM,
): Promise<ResolvedAction> {

  const prompt = `
You are translating a single natural-language test step into a concrete browser
action that a Playwright agent can execute.

You MUST reply with a JSON object, no prose, no markdown.

Schema:
  tool:     "click" | "fill" | "goto" | "wait" | "assert_text" | "press" | "noop"
  target:   string                — CSS selector, role-like description, or URL/text (see examples)
  value:    string (optional)     — value to type for "fill", or key for "press" (e.g. "Enter")
  locator:  "css" | "role" | "text" | "placeholder" | "label" (optional, default "css")
  rationale: string (optional)    — one short sentence explaining your choice

Tool semantics:
  click         — click the element identified by target+locator
  fill          — type \`value\` into the element identified by target+locator
  goto          — navigate to URL in target
  wait          — wait for selector in target to appear (use sparingly)
  assert_text   — observe whether the page contains the text in target. Missing text is not a bug by itself.
  press         — press a key (target = optional selector, value = key like "Enter")
  noop          — only use this when the step is impossible (e.g. asks for real signup)

Locator guidance:
  - Prefer "role" or "text" or "label" or "placeholder" when CSS selectors aren't obvious.
  - For role: target like "button:Sign in" or "link:Pricing" or "textbox:Email".
  - For text: target is the visible text.
  - For label: target is the form label text.
  - For placeholder: target is the input placeholder text.
  - Never invent selectors, search boxes, or exact page titles. Use only elements visible in the skeleton.
  - Do not turn page-title expectations into bugs; exploratory users observe what loaded.

Context:
  Flow:           ${flow.name} (${flow.kind})
  Flow goal:      ${flow.expectation}
  Step:           ${step.action}
  Expectation:    ${step.expectation || '(none stated)'}
  Current URL:    ${skeleton.url}
  Page title:     ${skeleton.title}

Visible page skeleton (top of body):
  Headings: ${skeleton.headings.slice(0, 8).join(' | ') || '(none)'}
  Buttons:  ${skeleton.buttons.slice(0, 12).join(' | ') || '(none)'}
  Links:    ${skeleton.links.slice(0, 12).map(l => l.text).join(' | ') || '(none)'}
  Inputs:   ${skeleton.inputs.slice(0, 12).map(i => `${i.label || i.placeholder || i.name || i.type}`).join(' | ') || '(none)'}

Reply with JSON only.`;

  return llm.generateJSON({
    label: 'runner.resolveAction',
    prompt,
    schema: ActionSchema,
  });

}

/* ── Action execution ─────────────────────────────────────────────────── */

interface ActionOutcome {
  status: StepStatus;
  observation: string;
  error?: string;
}

async function executeAction(page: Page, action: ResolvedAction, timeoutMs: number): Promise<ActionOutcome> {

  try {

    switch (action.tool){

      case 'click': {
        const locator = buildLocator(page, action);
        await locator.first().click({ timeout: timeoutMs });
        await settleSPA(page).catch(() => {});
        return { status: 'passed', observation: `Clicked ${describeTarget(action)}.` };
      }

      case 'fill': {
        const locator = buildLocator(page, action);
        await locator.first().fill(action.value ?? '', { timeout: timeoutMs });
        return { status: 'passed', observation: `Typed "${truncate(action.value ?? '', 40)}" into ${describeTarget(action)}.` };
      }

      case 'goto': {
        const url = action.target || '';
        if (!/^https?:\/\//.test(url)){
          return { status: 'failed', observation: `Refused to navigate to non-http URL "${url}".`, error: 'invalid_url' };
        }
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        await settleSPA(page).catch(() => {});
        return { status: 'passed', observation: `Navigated to ${url}.` };
      }

      case 'wait': {
        const locator = buildLocator(page, action);
        await locator.first().waitFor({ state: 'visible', timeout: timeoutMs });
        return { status: 'passed', observation: `Confirmed ${describeTarget(action)} is visible.` };
      }

      case 'assert_text': {
        const text = action.target || '';
        if (!text) return { status: 'skipped', observation: 'No text supplied for observation.' };
        const found = await page.locator('body').filter({ hasText: text }).first().count();
        if (found > 0){
          return { status: 'passed', observation: `Observed "${truncate(text, 60)}" on the page.` };
        }
        return {
          status: 'skipped',
          observation: `Did not observe "${truncate(text, 60)}" on the page. Treated as an exploratory observation, not a product bug.`,
        };
      }

      case 'press': {
        const key = action.value || 'Enter';
        if (action.target){
          const locator = buildLocator(page, action);
          await locator.first().press(key, { timeout: timeoutMs });
        } else {
          await page.keyboard.press(key);
        }
        await settleSPA(page).catch(() => {});
        return { status: 'passed', observation: `Pressed ${key}${action.target ? ` on ${describeTarget(action)}` : ''}.` };
      }

      case 'noop': {
        return {
          status: 'skipped',
          observation: action.rationale || 'Step intentionally skipped — not safe to automate.',
        };
      }

    }

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isSoftAutomationMiss(msg)){
      return {
        status: 'skipped',
        observation: `${capitalise(action.tool)} on ${describeTarget(action)} could not be completed by the agent (${truncate(msg, 140)}). Treated as inconclusive rather than a product bug.`,
      };
    }
    return {
      status: 'failed',
      observation: `${capitalise(action.tool)} on ${describeTarget(action)} failed: ${truncate(msg, 160)}`,
      error: msg,
    };
  }

  return { status: 'skipped', observation: 'Unknown tool — skipped.' };

}

function isSoftAutomationMiss(msg: string): boolean {
  const lower = msg.toLowerCase();
  return lower.includes('timeout') && (
    lower.includes('waiting for locator')
    || lower.includes('locator.fill')
    || lower.includes('locator.click')
    || lower.includes('locator.press')
    || lower.includes('locator.waitfor')
  );
}

/* ── Locator strategies ───────────────────────────────────────────────── */

function buildLocator(page: Page, action: ResolvedAction){
  const target = action.target || '';
  const strategy = action.locator || 'css';

  switch (strategy){
    case 'role': {
      // target is "role:label" e.g. "button:Sign in"
      const m = target.match(/^([a-z]+)\s*:\s*(.+)$/i);
      if (m){
        return page.getByRole(m[1] as any, { name: new RegExp(escapeRegex(m[2]), 'i') });
      }
      return page.getByRole(target as any);
    }
    case 'text':
      return page.getByText(target, { exact: false });
    case 'placeholder':
      return page.getByPlaceholder(target);
    case 'label':
      return page.getByLabel(target);
    case 'css':
    default:
      return page.locator(target);
  }

}

/* ── Page skeleton (LLM context for the runner) ──────────────────────── */

interface PageSkeletonForLLM {
  url: string;
  title: string;
  headings: string[];
  buttons: string[];
  links: { text: string; href: string }[];
  inputs: { label?: string; placeholder?: string; name?: string; type?: string }[];
}

async function skeletonForLLM(page: Page): Promise<PageSkeletonForLLM> {

  const url = page.url();
  const title = await page.title().catch(() => '');

  const collected = await page.evaluate(() => {

    function txt(el: Element): string {
      return (el.textContent || '').trim().replace(/\s+/g, ' ');
    }

    const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
      .map(txt).filter(Boolean).slice(0, 12);

    const buttons = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'))
      .map(b => txt(b) || (b as HTMLInputElement).value || '')
      .filter(Boolean).slice(0, 25);

    const links = Array.from(document.querySelectorAll('a[href]'))
      .slice(0, 25)
      .map(a => ({
        text: txt(a),
        href: (a as HTMLAnchorElement).href,
      }))
      .filter(l => l.text);

    const inputs = Array.from(document.querySelectorAll('input, textarea, select'))
      .slice(0, 25)
      .map(el => {
        const i = el as HTMLInputElement;
        const labelEl = i.id ? document.querySelector(`label[for="${CSS.escape(i.id)}"]`) : null;
        return {
          label: labelEl ? txt(labelEl) : undefined,
          placeholder: i.placeholder || undefined,
          name: i.name || undefined,
          type: i.type || i.tagName.toLowerCase(),
        };
      });

    return { headings, buttons, links, inputs };

  });

  return {
    url,
    title,
    ...collected,
  };

}

/* ── Helpers ──────────────────────────────────────────────────────────── */

async function settleSPA(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => {});
  await page.waitForFunction(
    () => (document.body?.innerText || '').replace(/\s+/g, '').length > 30,
    undefined,
    { timeout: 6_000 },
  ).catch(() => {});
}

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

function flowTimeoutGuard(flow: TestFlow, timeoutMs: number, started: number): Promise<FlowResult> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`flow "${flow.name}" exceeded ${timeoutMs}ms`)), timeoutMs);
  });
}

function finaliseFlow(
  flow: TestFlow,
  steps: StepResult[],
  failed: boolean,
  failureReason: string | undefined,
  started: number,
  videoPath?: string,
): FlowResult {

  const status: FlowResult['status'] = failed ? 'failed' : 'passed';

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
      flowsTotal: 0, flowsPassed: 0, flowsFailed: 0,
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
    stepsTotal, stepsPassed, stepsFailed,
    bugsCritical: 0, bugsMajor: 0, bugsMinor: 0, // filled in by the triager
  };
}

function describeTarget(action: ResolvedAction): string {
  if (!action.target) return '(no target)';
  const prefix = action.locator && action.locator !== 'css' ? `${action.locator}:` : '';
  return `${prefix}${truncate(action.target, 60)}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function capitalise(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'flow';
}
