/**
 * Run and flow outcome.
 *
 * `outcome`, `outcome_reason`, and `outcome_detail` use the SaaS field names
 * so a host can copy them onto `audit_run` without renaming. Existing
 * `bugs`, `stats`, and `flows[].status` values keep their meaning.
 * `inconclusive` is a new flow status for a journey that did not actually
 * run (every step skipped, or the only failures were ours).
 *
 * `outcome_detail` is deterministic. `alignVerdict` rejects an LLM sentence
 * that disagrees with the filtered bug count.
 */

import {
  isAutomationFault,
  isRealSiteFailureText,
  matchesClientSoftExploratory,
} from './automation/signatures.js';
import type { BugText } from './automation/signatures.js';
import { resolveFlowStatus } from './runner/flowStatus.js';
import type {
  FlowResult,
  OutcomeReason,
  RunOutcome,
  RunResult,
  StepResult,
  TraceStep,
} from './types.js';

export interface OutcomeContext {
  /** Pages the explorer actually opened. `0` means the site was not visited. */
  pagesVisited?: number;
  /** Planner or explorer note when the run stopped early. */
  notes?: string;
}

const UNREACHABLE = /net::err_(name_not_resolved|connection_refused|connection_reset|connection_timed_out|internet_disconnected|address_unreachable|network_changed|connection_closed|socket_not_connected|timed_out)|err_connection|dns_probe|enotfound|econnrefused|chrome-error:\/\/chromewebdata/i;
const INVALID_URL = /invalid_url|refused to navigate to non-http|not a valid url/i;
const BOT_WALL = /cloudflare|cf-browser-verification|cf-ray|just a moment|attention required|verify you are human|captcha|recaptcha|hcaptcha|akamai|perimeterx|datadome|bot protection|blocked by (a )?bot/i;
/**
 * A login wall we actually saw. The planner's "needs an account" skip, and
 * the old "Login-path testing is available on … plans" line, are not evidence.
 */
const LOGIN_WALL = /input\[type=["']?password|type=["']password["']|password (field|input|box)|sign-in form|signin form|login form|authentication required|please (log|sign) in to continue|auth(?:entication)? wall/i;
const LLM_FAILURE = /could not interpret this step|planner model response|planner failed|no usable step/i;
const FLOW_TIMEOUT = /exceeded \d+ms|flow ["']?.+["']? exceeded|timed out after/i;

function stepText(step: Pick<StepResult, 'error' | 'observation' | 'action' | 'expectation'>): string {
  return `${step.error || ''}\n${step.observation || ''}\n${step.action || ''}\n${step.expectation || ''}`;
}

function isRealStep(step: StepResult): boolean {
  return isRealSiteFailureText(`${step.error || ''}\n${step.observation || ''}`);
}

export function reasonForText(text: string | undefined): OutcomeReason | undefined {
  const raw = text || '';
  if (!raw.trim()) return undefined;
  if (isRealSiteFailureText(raw)) return undefined;
  if (UNREACHABLE.test(raw)) return 'site_unreachable';
  if (INVALID_URL.test(raw)) return 'invalid_url';
  if (BOT_WALL.test(raw)) return 'blocked_by_bot_protection';
  if (LOGIN_WALL.test(raw)) return 'login_required';
  if (isAutomationFault(raw)) return 'automation_error';
  const asBug: BugText = { severity: 'major', title: raw.slice(0, 180), observed: raw };
  if (matchesClientSoftExploratory(asBug)) return 'automation_error';
  if (LLM_FAILURE.test(raw)) return 'llm_error';
  if (FLOW_TIMEOUT.test(raw) && !/locator|selector/i.test(raw)) return 'timeout';
  return undefined;
}

function demoteStep(step: StepResult): StepResult {
  if (step.status !== 'failed') return step;
  if (isRealStep(step)) return step;
  const reason = reasonForText(stepText(step));
  if (!reason) return step;
  return { ...step, status: 'skipped' };
}

function demoteTrace(step: TraceStep, failed: boolean): TraceStep {
  if (!failed || step.status !== 'failed') return step;
  if (isRealSiteFailureText(`${step.error || ''}\n${step.observation || ''}`)) return step;
  if (!reasonForText(`${step.error || ''}\n${step.observation || ''}\n${step.action || ''}`)) return step;
  return { ...step, status: 'skipped' };
}

const REASON_PRIORITY: OutcomeReason[] = [
  'site_unreachable',
  'invalid_url',
  'blocked_by_bot_protection',
  'login_required',
  'timeout',
  'llm_error',
  'automation_error',
  'all_flows_skipped',
  'not_attempted',
  'nothing_tested',
];

function firstReason(reasons: Array<OutcomeReason | undefined>): OutcomeReason | undefined {
  for (const code of REASON_PRIORITY) {
    if (reasons.includes(code)) return code;
  }
  return undefined;
}

function flowDetail(reason: OutcomeReason, flow: FlowResult): string {
  const name = flow.name || 'this journey';
  switch (reason) {
    case 'login_required':
      return `Our test couldn't complete ${name} because the page shows a login wall. Test the public pages, or run the CLI with credentials.`;
    case 'blocked_by_bot_protection':
      return `Our test couldn't complete ${name} because the site blocked the automated browser. Try again later, or run the CLI from your own network.`;
    case 'site_unreachable':
      return `Our test couldn't complete ${name} because the page did not load. Check the URL and that the site is up, then run again.`;
    case 'invalid_url':
      return `Our test couldn't complete ${name} because the address is not an http(s) page. Pass a page URL, then run again.`;
    case 'llm_error':
      return `Our test couldn't complete ${name} because the model could not turn the step into an action. Run again.`;
    case 'timeout':
      return `Our test couldn't complete ${name} because the page did not finish in time. Run again, or raise the step timeout.`;
    case 'automation_error':
      return `Our test couldn't complete ${name} because the runner hit its own browser error. This is not a bug in the site. Run again with the latest engine.`;
    case 'not_attempted':
      return `Our test couldn't complete ${name} because that journey was not executed. Run a public page, or use the CLI for a login flow.`;
    case 'all_flows_skipped':
      return `Our test couldn't complete ${name} because every step was skipped. Pick a page with a form, search box, or primary button and run again.`;
    default:
      return `Our test couldn't complete ${name}. Check the URL and run again.`;
  }
}

function classifyFlow(flow: FlowResult): FlowResult {
  const steps = flow.steps.map(demoteStep);
  const trace = flow.trace
    ? {
      ...flow.trace,
      steps: flow.trace.steps.map(step => {
        const match = steps.find(item => item.index === step.index);
        return demoteTrace(step, match?.status === 'skipped' && step.status === 'failed');
      }),
    }
    : undefined;

  if (flow.status === 'blocked') {
    const evidence = `${flow.failureReason || ''}\n${steps.map(stepText).join('\n')}`;
    const reason = reasonForText(evidence) === 'login_required'
      ? 'login_required'
      : (reasonForText(evidence) || 'not_attempted');
    return {
      ...flow,
      steps,
      bugIds: [],
      ...(trace ? { trace } : {}),
      outcome_reason: reason,
      outcome_detail: flowDetail(reason, flow),
    };
  }

  if (flow.status === 'error') {
    const reason = reasonForText(flow.failureReason) || 'timeout';
    return {
      ...flow,
      steps,
      bugIds: [],
      ...(trace ? { trace } : {}),
      outcome_reason: reason,
      outcome_detail: flowDetail(reason, flow),
    };
  }

  const status = resolveFlowStatus(steps, false);
  if (status === 'failed') {
    return {
      ...flow,
      status,
      steps,
      bugIds: [],
      ...(trace ? { trace } : {}),
      outcome_reason: undefined,
      outcome_detail: undefined,
    };
  }

  if (status === 'inconclusive') {
    const fromSteps = steps.map(step => reasonForText(stepText(step)));
    const reason = firstReason([...fromSteps, reasonForText(flow.failureReason)]) || 'all_flows_skipped';
    return {
      ...flow,
      status: 'inconclusive',
      steps,
      bugIds: [],
      ...(trace ? { trace } : {}),
      outcome_reason: reason,
      outcome_detail: flowDetail(reason, flow),
    };
  }

  return {
    ...flow,
    status,
    steps,
    bugIds: [],
    ...(trace ? { trace } : {}),
    outcome_reason: undefined,
    outcome_detail: undefined,
  };
}

function recount(flows: FlowResult[]): RunResult['stats'] {
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
    flowsInconclusive: flows.filter(flow => flow.status === 'inconclusive').length,
    stepsTotal,
    stepsPassed,
    stepsFailed,
    bugsCritical: 0,
    bugsMajor: 0,
    bugsMinor: 0,
  };
}

/** Demote our own failures and mark all-skipped flows inconclusive. Bugs are filled in by triage after this. */
export function classifyRunFlows(run: RunResult): RunResult {
  const flows = run.flows.map(classifyFlow);
  return {
    ...run,
    flows,
    bugs: [],
    stats: recount(flows),
  };
}

function runDetail(outcome: RunOutcome, reason: OutcomeReason | undefined, bugCount: number): string {
  if (outcome === 'bugs_found') {
    const noun = bugCount === 1 ? 'bug' : 'bugs';
    return `Found ${bugCount} confirmed ${noun}. Open the top one and confirm it on the site before treating this run as healthy.`;
  }
  if (outcome === 'clean') {
    return 'The journeys we completed worked smoothly, and there were no confirmed bugs. Run a broader pass if you want more pages and journeys covered.';
  }
  switch (reason) {
    case 'login_required':
      return 'Our test couldn\'t complete the run because a page shows a login wall. Test the public pages, or run the CLI with credentials.';
    case 'blocked_by_bot_protection':
      return 'Our test couldn\'t complete the visit because the site blocked the automated browser. Try again later, or run the CLI from your own network.';
    case 'site_unreachable':
      return 'Our test couldn\'t complete a visit because the site did not load. Check the URL and that the site is up, then run again.';
    case 'invalid_url':
      return 'Our test couldn\'t complete a visit because the address is not an http(s) page. Pass a page URL, then run again.';
    case 'llm_error':
      return 'Our test couldn\'t complete a plan because the model did not return a usable journey. Run again.';
    case 'timeout':
      return 'Our test couldn\'t complete the run because a page did not finish in time. Run again, or raise the step timeout.';
    case 'automation_error':
      return 'Our test couldn\'t complete a journey because the runner hit its own browser error. This is not a bug in the site. Run again with the latest engine.';
    case 'not_attempted':
      return 'Our test couldn\'t complete the planned journeys because they were not executed. Run a public page with a form or a primary button.';
    case 'all_flows_skipped':
      return 'Our test couldn\'t complete the planned journeys because every step was skipped. Pick a page with a form, search box, or primary button and run again.';
    default:
      return 'Our test couldn\'t complete a visit because nothing was executed. Check the URL and run again.';
  }
}

function pickCouldNotTest(reasons: OutcomeReason[], ctx: OutcomeContext): OutcomeReason {
  const notes = ctx.notes || '';
  if (reasons.includes('invalid_url') || INVALID_URL.test(notes)) return 'invalid_url';
  if (reasons.includes('blocked_by_bot_protection') || BOT_WALL.test(notes)) return 'blocked_by_bot_protection';
  if (reasons.includes('login_required')) return 'login_required';
  if (reasons.includes('site_unreachable') || ctx.pagesVisited === 0) return 'site_unreachable';
  if (reasons.includes('llm_error') || /planner (model|failed)|could not be used/i.test(notes)) return 'llm_error';
  if (reasons.includes('timeout')) return 'timeout';
  return 'nothing_tested';
}

function pickInconclusive(reasons: OutcomeReason[]): OutcomeReason {
  if (reasons.length === 0) return 'all_flows_skipped';
  const onlySkip = reasons.every(reason => reason === 'all_flows_skipped' || reason === 'not_attempted' || reason === 'nothing_tested');
  if (onlySkip) {
    if (reasons.every(reason => reason === 'not_attempted')) return 'not_attempted';
    return 'all_flows_skipped';
  }
  return firstReason(reasons) || 'all_flows_skipped';
}

export interface DerivedOutcome {
  outcome: RunOutcome;
  outcome_reason?: OutcomeReason;
  outcome_detail: string;
}

/** Bug count is the filtered list on `run.bugs`. */
export function deriveRunOutcome(run: RunResult, ctx: OutcomeContext = {}): DerivedOutcome {
  const bugCount = run.bugs.length;
  if (bugCount > 0) {
    return { outcome: 'bugs_found', outcome_detail: runDetail('bugs_found', undefined, bugCount) };
  }

  const reasons = run.flows
    .map(flow => flow.outcome_reason)
    .filter((reason): reason is OutcomeReason => Boolean(reason));
  const anyPassed = run.flows.some(flow => flow.status === 'passed');
  const hardStop = new Set<OutcomeReason>(['site_unreachable', 'invalid_url', 'blocked_by_bot_protection']);
  const nothingRan = run.flows.length === 0 || ctx.pagesVisited === 0;
  const onlyUnreachable = run.flows.length > 0
    && !anyPassed
    && reasons.length > 0
    && reasons.every(reason => hardStop.has(reason));

  if (nothingRan || onlyUnreachable) {
    const outcome_reason = pickCouldNotTest(reasons, ctx);
    return {
      outcome: 'could_not_test',
      outcome_reason,
      outcome_detail: runDetail('could_not_test', outcome_reason, 0),
    };
  }

  if (!anyPassed) {
    const outcome_reason = pickInconclusive(reasons);
    return {
      outcome: 'inconclusive',
      outcome_reason,
      outcome_detail: runDetail('inconclusive', outcome_reason, 0),
    };
  }

  return { outcome: 'clean', outcome_detail: runDetail('clean', undefined, 0) };
}

export function attachRunOutcome(run: RunResult, ctx: OutcomeContext = {}): RunResult {
  const derived = deriveRunOutcome(run, ctx);
  return {
    ...run,
    outcome: derived.outcome,
    outcome_reason: derived.outcome_reason,
    outcome_detail: derived.outcome_detail,
  };
}

export interface VerdictFacts {
  bugCount: number;
  outcome: RunOutcome;
  /** Deterministic sentence. Used when `draft` contradicts the facts. */
  outcome_detail: string;
}

function claimsABug(text: string): boolean {
  return /major bug|critical bug|high bug|check right away|found \d+ confirmed bugs?|\b\d+ confirmed bugs?\b/i.test(text);
}

function claimsSmooth(text: string): boolean {
  return /worked smoothly|working smoothly|no confirmed bugs|without (any )?bugs|clean bill of health|no issues found/i.test(text);
}

/**
 * True when an LLM sentence disagrees with the filtered bug count or the
 * outcome. "Worked smoothly" beside a bug, and "major bug" with zero bugs,
 * are both contradictions.
 */
export function verdictContradicts(draft: string, facts: VerdictFacts): boolean {
  const text = draft.trim();
  if (!text) return true;
  if (facts.bugCount > 0 && claimsSmooth(text)) return true;
  if (facts.bugCount === 0 && claimsABug(text)) return true;
  if (facts.outcome !== 'clean' && claimsSmooth(text)) return true;
  if (facts.outcome !== 'bugs_found' && claimsABug(text)) return true;
  if ((facts.outcome === 'inconclusive' || facts.outcome === 'could_not_test')
    && !/our test couldn'?t complete/i.test(text)) return true;
  return false;
}

/**
 * Keep `draft` only when it agrees with the filtered bug count. Otherwise
 * return the deterministic `outcome_detail`.
 */
export function alignVerdict(draft: string | undefined, facts: VerdictFacts): string {
  const text = (draft || '').trim();
  if (!text || verdictContradicts(text, facts)) return facts.outcome_detail;
  return text;
}
