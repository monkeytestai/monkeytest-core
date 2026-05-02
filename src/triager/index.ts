/**
 * Triager phase
 *
 * Converts the runner's raw FlowResult[] into a deduplicated list of
 * BugReport entries. Each failed step → one bug, but identical failures
 * across flows (same step text, same target, same error) collapse into a
 * single bug with merged evidence so the report doesn't show a wall of
 * near-duplicate cards.
 *
 * v0.2 keeps this rule-based on purpose:
 *   - it is fast (zero LLM calls in the hot path),
 *   - it is deterministic (no flaky "the LLM got bored" variance),
 *   - and the bugs it produces are exactly what the runner observed —
 *     no hallucinated severities, no invented repro steps.
 *
 * A future v0.3 can add an LLM "polish" pass that rewrites titles,
 * suggests fixes, and groups semantically-related bugs.
 */

import { createHash } from 'node:crypto';
import type {
  RunResult,
  FlowResult,
  StepResult,
  BugReport,
  BugEvidence,
} from '../types.js';

export function triage(run: RunResult): RunResult {

  const bugs: BugReport[] = [];
  const byFingerprint = new Map<string, BugReport>();

  for (const flow of run.flows){

    for (const step of flow.steps){

      if (step.status !== 'failed') continue;

      const bug = bugFromStep(flow, step);
      const existing = byFingerprint.get(bug.fingerprint);

      if (existing){
        // Merge evidence — capturing additional screenshots/console errors
        // from a duplicate occurrence makes the bug card more useful.
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

  // Tally severities into the run stats.
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

  // Stable fingerprint: action text + tool + a normalised error code.
  // We deliberately don't include the URL — the same login bug on /signin
  // and /login should still collapse into one entry.
  const fingerprint = createHash('sha1')
    .update([
      step.action.trim().toLowerCase(),
      step.tool || 'unknown',
      normalisedErrorCode(step),
    ].join('|'))
    .digest('hex')
    .slice(0, 16);

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

  return {
    id,
    fingerprint,
    title: shortTitle(flow, step),
    severity,
    affectedFlow: flow.name,
    reproSteps,
    observed: observation,
    expected: step.expectation || flow.description || 'The step should complete without error.',
    evidence,
    triageNotes: explain(step),
  };

}

function normalisedErrorCode(step: StepResult): string {
  const err = (step.error || '').toLowerCase();
  if (!err) return 'no-error';
  if (err.includes('timeout')) return 'timeout';
  if (err.includes('not found') || err.includes('no element')) return 'selector-missing';
  if (err.includes('not visible') || err.includes('hidden')) return 'element-hidden';
  if (err.includes('navigation')) return 'navigation-failed';
  if (err.includes('assertion_failed')) return 'assertion-failed';
  if (err.includes('invalid_url')) return 'invalid-url';
  return err.replace(/\s+/g, '-').slice(0, 40);
}

/**
 * Severity is mostly inherited from the planner's `severityIfFails`, but
 * we bump it up when the failure is accompanied by hard signal (5xx
 * responses, page errors, etc.) — that's almost always a real bug rather
 * than a flaky selector.
 */
function inferSeverity(flow: FlowResult, step: StepResult): BugReport['severity'] {
  const has5xx = (step.networkFailures || []).some(n => (n.status || 0) >= 500);
  const hasPageError = (step.consoleErrors || []).some(c => c.level === 'error');

  // The flow we got from the runner doesn't carry severityIfFails, but the
  // runner copies it from the plan via the FlowResult shape extension. If
  // missing, default to "major" — a failed planned step is rarely trivial.
  const planned = (flow as any).severityIfFails as BugReport['severity'] | undefined;
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
