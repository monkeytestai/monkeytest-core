/**
 * Promote same-origin HTTP ≥500 responses into failed steps.
 *
 * Strict oracles already do this for `passed` steps, any origin, and only
 * while that option is on. Two gaps remained:
 *
 *   - a step the runner marked `skipped` (soft locator miss) kept its 5xx
 *     evidence and the triager ignored it
 *   - a passed or skipped step can still carry a same-origin 500 when the
 *     runner was not asked to fail on it
 *
 * This pass runs when `failOn5xx` is set. The CLI and `new Monkey()` turn it
 * on. Pass `failOn5xx: false` to opt out. A direct `triage(run)` does not.
 * Image, font, and other non-action responses stay evidence only. Third-party
 * 5xx responses stay evidence only. `www` and the apex host are treated as
 * the same site; the port is not ignored.
 */

import type { ActionOutcome } from './actions.js';
import { isActionServerError } from './evidence.js';
import type {
  FlowResult,
  NetworkFailureEvidence,
  RunResult,
  StepResult,
  TraceStep,
} from '../types.js';

export function collectOrigins(urls: Array<string | undefined>): string[] {
  const origins: string[] = [];
  for (const value of urls) {
    if (!value) continue;
    try {
      const origin = new URL(value).origin;
      if (!origins.includes(origin)) origins.push(origin);
    } catch { /* not a URL */ }
  }
  return origins;
}

export function isSameSiteUrl(resourceUrl: string, allowedOrigins: string[]): boolean {
  let resource: URL;
  try { resource = new URL(resourceUrl); }
  catch { return false; }
  if (resource.protocol !== 'http:' && resource.protocol !== 'https:') return false;
  const key = siteKey(resource);
  return allowedOrigins.some(origin => {
    try { return siteKey(new URL(origin)) === key; }
    catch { return false; }
  });
}

export function findSameOriginServerError(
  network: NetworkFailureEvidence[] | undefined,
  origins: string[],
): NetworkFailureEvidence | undefined {
  if (!network?.length || origins.length === 0) return undefined;
  return network.find(item => isActionServerError(item) && isSameSiteUrl(item.url, origins));
}

export function describeServerError(hit: NetworkFailureEvidence): string {
  return `${hit.method} ${hit.url} returned HTTP ${hit.status}.`;
}

/** Upgrade a passed or skipped action outcome. Failed and blocked stay as they are. */
export function outcomeWithSameOrigin5xx(
  outcome: ActionOutcome,
  failures: NetworkFailureEvidence[] | undefined,
  origins: string[],
): ActionOutcome {
  if (outcome.status === 'failed' || outcome.status === 'blocked') return outcome;
  const hit = findSameOriginServerError(failures, origins);
  if (!hit?.status) return outcome;
  return {
    status: 'failed',
    observation: `${outcome.observation} ${describeServerError(hit)}`.trim(),
    error: `http-${hit.status}`,
  };
}

export function promoteStepFor5xx(step: StepResult, origins: string[]): StepResult {
  if (step.status !== 'passed' && step.status !== 'skipped') return step;
  const hit = findSameOriginServerError(step.networkFailures, origins);
  if (!hit?.status) return step;
  return {
    ...step,
    status: 'failed',
    error: `http-${hit.status}`,
    observation: `${step.observation} ${describeServerError(hit)}`.trim(),
  };
}

export function promoteRecordedSteps(
  steps: StepResult[],
  traceSteps: TraceStep[],
  origins: string[],
): {
  steps: StepResult[];
  traceSteps: TraceStep[];
  failed: boolean;
  failureReason?: string;
  changed: boolean;
} {
  let changed = false;
  let failureReason: string | undefined;
  const nextSteps = steps.map(step => {
    const promoted = promoteStepFor5xx(step, origins);
    if (promoted !== step) changed = true;
    if (!failureReason && promoted.status === 'failed' && promoted !== step) {
      failureReason = promoted.error || promoted.observation;
    }
    return promoted;
  });
  const nextTrace = traceSteps.map(traceStep => {
    const match = nextSteps.find(step => step.index === traceStep.index);
    if (!match) return traceStep;
    if (
      match.status === traceStep.status
      && match.error === traceStep.error
      && match.observation === traceStep.observation
    ) return traceStep;
    changed = true;
    return {
      ...traceStep,
      status: match.status,
      observation: match.observation,
      error: match.error,
      networkFailures: match.networkFailures ?? traceStep.networkFailures,
    };
  });
  return {
    steps: nextSteps,
    traceSteps: nextTrace,
    failed: nextSteps.some(step => step.status === 'failed'),
    failureReason,
    changed,
  };
}

/**
 * Triage-time safety net. A run step that already carries a same-origin
 * HTTP ≥500 becomes `failed` before fingerprints are computed, including
 * when the runner left it `passed` or `skipped`.
 */
export function applySameOrigin5xxToRun(run: RunResult): RunResult {
  let changed = false;
  const flows: FlowResult[] = run.flows.map(flow => {
    if (flow.status === 'error') return flow;
    const origins = collectOrigins([flow.startUrl, run.startUrl]);
    const promoted = promoteRecordedSteps(flow.steps, flow.trace?.steps ?? [], origins);
    if (!promoted.changed) return flow;
    changed = true;
    const failed = promoted.steps.some(step => step.status === 'failed');
    return {
      ...flow,
      steps: promoted.steps,
      status: failed ? 'failed' : flow.status,
      failureReason: flow.failureReason || (failed ? promoted.failureReason : undefined),
      ...(flow.trace ? { trace: { ...flow.trace, steps: promoted.traceSteps } } : {}),
    };
  });
  if (!changed) return run;
  const counts = recount(flows);
  return {
    ...run,
    flows,
    stats: {
      ...counts,
      bugsCritical: run.stats.bugsCritical,
      bugsMajor: run.stats.bugsMajor,
      bugsMinor: run.stats.bugsMinor,
    },
  };
}

function siteKey(url: URL): string {
  const host = url.hostname.replace(/^www\./i, '').toLowerCase();
  return `${url.protocol}//${host}${url.port ? `:${url.port}` : ''}`;
}

function recount(flows: FlowResult[]): Omit<RunResult['stats'], 'bugsCritical' | 'bugsMajor' | 'bugsMinor'> {
  let stepsTotal = 0;
  let stepsPassed = 0;
  let stepsFailed = 0;
  for (const flow of flows) {
    for (const step of flow.steps) {
      stepsTotal += 1;
      if (step.status === 'passed') stepsPassed += 1;
      if (step.status === 'failed') stepsFailed += 1;
    }
  }
  return {
    flowsTotal: flows.length,
    flowsPassed: flows.filter(flow => flow.status === 'passed').length,
    flowsFailed: flows.filter(flow => flow.status === 'failed' || flow.status === 'error').length,
    flowsBlocked: flows.filter(flow => flow.status === 'blocked').length,
    stepsTotal,
    stepsPassed,
    stepsFailed,
  };
}
