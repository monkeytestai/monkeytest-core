/**
 * Triager phase
 *
 * Converts the runner's raw FlowResult[] into a deduplicated list of
 * BugReport entries. Each failed step → one bug, but identical failures
 * across flows (same failure category, page, element, and error signal)
 * collapse into a single bug with merged evidence so the report doesn't
 * show a wall of near-duplicate cards.
 *
 * Two layers:
 *
 *   1. Rule-based (always on)
 *      - Fast, deterministic, zero LLM calls.
 *      - Bugs reflect exactly what the runner observed — no hallucinated
 *        severities, no invented repro steps.
 *      - This is the floor. Even if everything else fails, you get this.
 *
 *   2. LLM polish (opt-in via MonkeyConfig.llm.triager)
 *      - Rewrites titles, observed/expected wording, and triage notes from
 *        the structured evidence the rule-based layer already produced.
 *      - Per-bug try/catch — a bad LLM response on bug 3 never affects bug 4.
 *      - Falls back to the rule-based output on any error.
 *      - Uses prompt caching: system prompt is stable, bug evidence is the
 *        per-call payload.
 */

import { z } from 'zod';
import { clipText, coerceProse, unwrapModelObject } from '../llm/coerce.js';
import type { LLM } from '../llm/index.js';
import type {
  RunResult,
  FlowResult,
  StepResult,
  BugReport,
  BugEvidence,
  BugElement,
} from '../types.js';
import { type EventBus, noopBus } from '../events.js';
import { failureLocation, fingerprintFailure, legacyFingerprint } from '../trace/fingerprint.js';
import { bugTracePrefix } from '../trace/serialize.js';
import { applySameOrigin5xxToRun } from '../runner/http5xx.js';
import { attachRunOutcome, classifyRunFlows, type OutcomeContext } from '../outcome.js';
import { isOwnAutomationBug } from '../automation/signatures.js';

export interface TriageOptions {
  /**
   * Optional LLM that "polishes" each bug — rewrites title / observed /
   * expected / triageNotes from the structured evidence. If omitted, only
   * the deterministic rule-based output ships.
   *
   * Cost is small (~120 input tokens cached + ~80 dynamic per bug, ~120
   * output) but real — keep it off for cheap CI runs.
   */
  llm?: LLM;
  /** Optional event bus. */
  events?: EventBus;
  /** Soft cap on bugs to polish per run (cost guard). Default 25. */
  maxBugsToPolish?: number;
  /**
   * Promote a passed or skipped step that saw a same-origin HTTP ≥500 into
   * a failed step before bugs are built. Default false. The CLI sets this
   * from `--fail-on-5xx` (on unless `--no-fail-on-5xx`). Leaving it off keeps
   * existing library bug counts.
   */
  failOn5xx?: boolean;
  /** Pages the explorer opened. `0` makes an empty run `could_not_test`. */
  pagesVisited?: number;
  /** Planner or explorer note, used when the run never started. */
  notes?: string;
}

/* ── Public entry ─────────────────────────────────────────────────────── */

/**
 * Synchronous, deterministic triage. Always available, always cheap. Use this
 * as a floor; layer `triagePolished` on top when you want LLM-improved copy.
 */
export function triage(run: RunResult, opts: OutcomeContext & { failOn5xx?: boolean } = {}): RunResult {
  const prepared = opts.failOn5xx ? applySameOrigin5xxToRun(run) : run;
  const classified = classifyRunFlows(prepared);
  return attachRunOutcome(collapseAndScore(classified), opts);
}

/**
 * Async triage that runs the rule-based pass and then *optionally* polishes
 * each bug with an LLM. Always returns a complete `RunResult`; bugs the LLM
 * fails to polish keep their rule-based copy.
 */
export async function triagePolished(
  run: RunResult,
  opts: TriageOptions = {}
): Promise<RunResult> {

  const events = opts.events ?? noopBus();
  const base = triage(run, { failOn5xx: opts.failOn5xx });

  if (!opts.llm || base.bugs.length === 0){
    return base;
  }

  const cap = opts.maxBugsToPolish ?? 25;
  const toPolish = base.bugs.slice(0, cap);

  events.emit({
    phase: 'triager', type: 'triage.start',
    message: `Polishing ${toPolish.length} bug${toPolish.length === 1 ? '' : 's'} with ${opts.llm.providerLabel}…`,
    data: { bugs: toPolish.length, model: opts.llm.providerLabel },
  });

  // Polish in parallel with a small concurrency window. Bug polishing is
  // independent per bug; the only shared state is the LLM client.
  const POLISH_CONCURRENCY = 4;
  const queue = [...toPolish];
  const polished: BugReport[] = [];
  let succeeded = 0;
  let failed = 0;

  async function worker(){
    while (queue.length > 0){
      const bug = queue.shift();
      if (!bug) return;
      try {
        const out = await polishBug(bug, opts.llm!);
        polished.push(out);
        succeeded++;
      } catch (err) {
        // Per-bug failure: keep the rule-based copy. Never throw from triage.
        polished.push(bug);
        failed++;
        events.emit({
          phase: 'triager', type: 'engine.error',
          message: `Polish failed for ${bug.id}; keeping deterministic copy.`,
          data: { bugId: bug.id, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  }
  await Promise.all(Array.from({ length: POLISH_CONCURRENCY }, () => worker()));

  // Restore original order (Promise.all is concurrent so polished order shifts).
  const byId = new Map(polished.map(b => [b.id, b]));
  const orderedPolished: BugReport[] = base.bugs.map(b => byId.get(b.id) ?? b);

  events.emit({
    phase: 'triager', type: 'triage.complete',
    message: `Triage complete: ${succeeded} polished, ${failed} fell back to deterministic.`,
    data: { succeeded, failed, total: base.bugs.length, ...(opts.llm.lastUsage ? { usage: opts.llm.lastUsage } : {}) },
  });

  return { ...base, bugs: orderedPolished };

}

/* ── Rule-based core ──────────────────────────────────────────────────── */

function collapseAndScore(run: RunResult): RunResult {

  const bugs: BugReport[] = [];
  const byFingerprint = new Map<string, BugReport>();

  for (const flow of run.flows){

    for (const step of flow.steps){

      if (step.status !== 'failed') continue;
      if (isOwnAutomationBug({
        severity: 'major',
        title: step.observation || step.action,
        observed: step.observation,
        expected: step.expectation,
        error: step.error,
      })) continue;

      const bug = bugFromStep(flow, step);
      const existing = byFingerprint.get(bug.fingerprint);

      if (existing){
        if (step.screenshotPath){
          existing.evidence.screenshots.push(step.screenshotPath);
        }
        if (step.consoleErrors){
          existing.evidence.consoleErrors.push(...step.consoleErrors);
        }
        if (step.networkFailures){
          existing.evidence.networkFailures.push(...step.networkFailures);
        }
        if (!existing.affectedFlow.includes(flow.name)){
          existing.affectedFlow = `${existing.affectedFlow}, ${flow.name}`;
        }
        flow.bugIds.push(existing.id);
      } else {
        byFingerprint.set(bug.fingerprint, bug);
        bugs.push(bug);
        flow.bugIds.push(bug.id);
      }

    }

  }

  const stats = { ...run.stats };
  for (const b of bugs){
    if (b.severity === 'critical') stats.bugsCritical++;
    else if (b.severity === 'major') stats.bugsMajor++;
    else stats.bugsMinor++;
  }

  return { ...run, bugs, stats };

}

/* ── BugReport synthesis ──────────────────────────────────────────────── */

function bugFromStep(flow: FlowResult, step: StepResult): BugReport {

  const observation = step.observation || step.error || 'Step failed.';
  const traceStep = flow.trace?.steps.find(item => item.index === step.index);
  const networkStatus = (step.networkFailures || []).find(item => (item.status || 0) >= 500)?.status;

  const fingerprint = legacyFingerprint({
    action: step.action,
    tool: step.tool,
    error: step.error,
  });
  const stable = fingerprintFailure({
    action: step.action,
    tool: traceStep?.tool || step.tool,
    error: step.error,
    observation,
    location: failureLocation({
      tool: traceStep?.tool || step.tool,
      locatorTarget: traceStep?.locator?.target || (step.tool === 'goto' ? step.target : undefined),
      urlBefore: traceStep?.urlBefore,
      urlAfter: traceStep?.urlAfter,
      fallback: flow.startUrl,
    }),
    locator: traceStep?.locator || step.locator,
    target: step.target,
    networkStatus,
  });

  const id = `bug-${flow.flowId}-${step.index}-${fingerprint.slice(0, 6)}`;

  const evidence: BugEvidence = {
    screenshots: step.screenshotPath ? [step.screenshotPath] : [],
    consoleErrors: step.consoleErrors ? [...step.consoleErrors] : [],
    networkFailures: step.networkFailures ? [...step.networkFailures] : [],
  };

  const reproSteps = [
    `Open ${flow.startUrl}`,
    ...flow.steps
      .filter(s => s.index < step.index && s.status !== 'blocked')
      .map(s => s.action),
    step.action,
  ];

  const severity = inferSeverity(flow, step);

  const trace = flow.trace ? bugTracePrefix(flow.trace, step.index) : undefined;
  const element = bugElement(step);

  return {
    id,
    fingerprint,
    fingerprintV2: stable.fingerprintV2,
    fingerprintParts: stable.parts,
    ...(trace && trace.steps.length > 0 ? { trace } : {}),
    title: shortTitle(flow, step),
    severity,
    affectedFlow: flow.name,
    reproSteps,
    observed: observation,
    expected: step.expectation || flow.description || 'The step should complete without error.',
    evidence,
    triageNotes: explain(step),
    impact: fallbackImpact(flow, step),
    page_url: pageUrlFor(flow, traceStep?.urlAfter, traceStep?.urlBefore),
    step_index: Math.max(0, step.index - 1),
    flow_id: flow.flowId,
    ...(element ? { element } : {}),
  };

}

function pageUrlFor(flow: FlowResult, urlAfter?: string, urlBefore?: string): string {
  const candidate = urlAfter || urlBefore || flow.startUrl;
  return candidate || flow.startUrl;
}

function bugElement(step: StepResult): BugElement | undefined {
  if (step.element?.selector || step.element?.bounding_box) return step.element;
  const selector = step.locator?.css || (step.locator?.strategy === 'css' ? step.locator.target : undefined);
  if (!selector) return undefined;
  return { selector };
}

/**
 * One line a report can show when the model did not write an impact.
 * The wording names the person and the control, not the Playwright error.
 */
export function fallbackImpact(flow: FlowResult, step: StepResult): string {
  const target = elementPhrase(step);
  const err = `${step.error || ''}\n${step.observation || ''}`.toLowerCase();
  let line = `Visitors can't complete ${target}.`;
  if (/\bhttp-5\d\d\b|http 5\d\d|internal server error/.test(err)) {
    line = `Visitors can't finish ${target} because the server returned an error.`;
  } else if (/pageerror|uncaught page error|page error/.test(err)) {
    line = `Visitors see a page error when they use ${target}.`;
  } else if (/element-disabled|control is disabled|element is disabled/.test(err)) {
    line = `Visitors can't use ${target} because it is disabled.`;
  } else if (/\bhttp-404\b|http 404/.test(err)) {
    line = `Visitors can't open ${target} because the page is missing.`;
  } else if (flow.name) {
    line = `Visitors can't complete ${target} on ${flow.name}.`;
  }
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

function elementPhrase(step: StepResult): string {
  const named = step.locator?.name || step.locator?.label;
  if (named) return `"${named.slice(0, 60)}"`;
  const target = (step.target || step.locator?.target || '').trim();
  const role = target.match(/^[a-z]+\s*:\s*(.+)$/i);
  if (role) return `"${role[1].slice(0, 60)}"`;
  if (target && !target.startsWith('http') && !target.includes('[') && target.length <= 80) return `"${target}"`;
  const action = step.action.replace(/\s+/g, ' ').trim();
  if (!action) return 'this step';
  return action.length > 60 ? `"${action.slice(0, 57)}…"` : `"${action}"`;
}

function inferSeverity(flow: FlowResult, step: StepResult): BugReport['severity'] {
  const has5xx = (step.networkFailures || []).some(n => (n.status || 0) >= 500);
  const hasPageError = (step.consoleErrors || []).some(c => c.level === 'error');

  const planned = (flow as unknown as { severityIfFails?: BugReport['severity'] }).severityIfFails;
  let severity: BugReport['severity'] = planned || 'major';

  if (has5xx || (step.error || '').toLowerCase().includes('crash')) severity = 'critical';
  else if (hasPageError && severity === 'minor') severity = 'major';

  return severity;
}

function shortTitle(flow: FlowResult, step: StepResult): string {
  const trimmedAction = step.action.length > 60 ? `${step.action.slice(0, 57)}…` : step.action;
  return `${flow.name}: ${trimmedAction}`;
}

function explain(step: StepResult): string {
  const parts: string[] = [];
  if (step.tool) parts.push(`The runner attempted a ${step.tool} on ${step.target || '(no target)'}.`);
  if (step.error) parts.push(`Underlying error: ${step.error.slice(0, 200)}.`);
  if ((step.networkFailures || []).length){
    const codes = (step.networkFailures || []).map(n => n.status || 'failed').join(', ');
    parts.push(`Network failures while this step ran: ${codes}.`);
  }
  if ((step.consoleErrors || []).length){
    parts.push(`${(step.consoleErrors || []).length} console error(s) fired during the step.`);
  }
  return parts.join(' ') || step.observation || 'Step failed without further detail.';
}

/* ── LLM polish ───────────────────────────────────────────────────────── */

/**
 * The polisher's contract:
 *   - Improve the *wording* of an existing bug; do not invent new bugs.
 *   - Keep severity and fingerprint exactly as given.
 *   - Be terse and engineer-friendly. No marketing fluff.
 *   - If the LLM returns garbage, throw — the caller falls back to the
 *     rule-based copy.
 */
function polishField(value: unknown, min: number, max: number): unknown {
  const text = coerceProse(value);
  if (!text) return value;
  const clipped = clipText(text, max);
  return clipped.length >= min ? clipped : text;
}

export const PolishedBugSchema = z.preprocess((value) => {
  const unwrapped = unwrapModelObject(value, ['title', 'observed', 'expected', 'triageNotes', 'impact']);
  if (!unwrapped || typeof unwrapped !== 'object' || Array.isArray(unwrapped)) return unwrapped;
  const record = unwrapped as Record<string, unknown>;
  const impact = polishField(record.impact ?? record.userImpact ?? record.user_impact, 8, 160);
  return {
    title: polishField(record.title ?? record.name, 8, 120),
    observed: polishField(record.observed ?? record.actual, 8, 600),
    expected: polishField(record.expected ?? record.expectation, 8, 400),
    triageNotes: polishField(record.triageNotes ?? record.notes ?? record.triage_notes, 8, 600),
    ...(typeof impact === 'string' ? { impact } : {}),
  };
}, z.object({
  title: z.string().min(8).max(120),
  observed: z.string().min(8).max(600),
  expected: z.string().min(8).max(400),
  triageNotes: z.string().min(8).max(600),
  impact: z.string().min(8).max(160).optional(),
}));

const POLISH_SYSTEM = `You are a senior QA engineer rewriting an automated bug report so it reads like a human-authored ticket.

Goal: tighten the wording. Keep the meaning identical. Be precise, not verbose.

Rules:
  - The "title" is a one-liner under 90 chars: <area>: <what broke>. No emoji, no severity, no flow id.
  - "observed" is what the test actually saw, in past tense, one or two sentences. Cite the concrete error if present.
  - "expected" is what should have happened, in present tense, one sentence.
  - "triageNotes" gives a senior engineer the next step: what to look at, what likely caused it (selector/timing/network/server). 1–3 sentences.
  - "impact" is one line a shopper would understand, such as "Shoppers can't add to cart". Omit the key if the evidence does not support a user-facing line.
  - NEVER invent details. If the evidence doesn't say it, don't claim it.
  - NEVER restate the JSON keys, the bug id, or the words "critical/major/minor".
  - Every field is a single string. Do not wrap a field in an object or array.

Respond with a single JSON object: { "title", "observed", "expected", "triageNotes", "impact"? }.`;

async function polishBug(bug: BugReport, llm: LLM): Promise<BugReport> {

  // The bug evidence is the per-call dynamic payload; it changes per bug,
  // so it's NOT cacheable. The system prompt above is the cached prefix.
  const evidenceLines = [
    bug.evidence.screenshots.length
      ? `screenshots: ${bug.evidence.screenshots.length} captured`
      : 'screenshots: none',
    bug.evidence.consoleErrors.length
      ? `console errors:\n${bug.evidence.consoleErrors.slice(0, 6).map(c => `  - [${c.level}] ${c.message.slice(0, 200)}`).join('\n')}`
      : 'console errors: none',
    bug.evidence.networkFailures.length
      ? `network failures:\n${bug.evidence.networkFailures.slice(0, 6).map(n => `  - ${n.method} ${n.url} → ${n.status || n.failureText || 'failed'}`).join('\n')}`
      : 'network failures: none',
  ].join('\n');

  const userPrompt = `Bug to rewrite:

  affectedFlow: ${bug.affectedFlow}
  severity:     ${bug.severity}

  current title:        ${bug.title}
  current observed:     ${bug.observed}
  current expected:     ${bug.expected}
  current triageNotes:  ${bug.triageNotes}

  reproSteps:
${bug.reproSteps.map((s, i) => `    ${i + 1}. ${s}`).join('\n')}

  evidence:
${evidenceLines.split('\n').map(l => `    ${l}`).join('\n')}

Rewrite. Same JSON shape.`;

  const raw = await llm.generateJSON({
    label: 'triager.polish',
    system: POLISH_SYSTEM,
    prompt: userPrompt,
    schema: PolishedBugSchema,
  });
  const polished = PolishedBugSchema.parse(raw);

  return {
    ...bug,
    title: polished.title.trim(),
    observed: polished.observed.trim(),
    expected: polished.expected.trim(),
    triageNotes: polished.triageNotes.trim(),
    ...(polished.impact ? { impact: polished.impact.trim() } : {}),
  };

}
