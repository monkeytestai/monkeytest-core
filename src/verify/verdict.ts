/**
 * Pure verdict rules for `monkeytest verify`.
 *
 * One replay attempt is:
 *   fixed         — the trace reached the failing step and it did not fail
 *   still_broken  — the failing step failed again
 *   healed        — a stale locator was re-resolved and the failure did not recur
 *   blocked       — a prefix step failed, so the failing step was never reached
 *
 * N attempts collapse to:
 *   still_broken  — the bug fired on every attempt
 *   flaky         — the bug fired on some but not all attempts
 *   healed        — it never fired, and at least one attempt re-resolved a locator
 *   fixed         — every attempt completed without the failure and without healing
 *   blocked       — the bug never fired, but not every attempt reached the step
 *
 * Exit code 1 is reserved for verdicts where the bug actually fired
 * (`still_broken`, `flaky`). `healed` and `blocked` are reported and exit 0.
 */

import type { TraceStep } from '../types.js';

export type VerifyAttempt = 'fixed' | 'still_broken' | 'healed' | 'blocked';
export type VerifyVerdict = 'fixed' | 'still_broken' | 'flaky' | 'healed' | 'blocked';

export function classifyAttempt(
  steps: TraceStep[],
  failingIndex: number,
): { outcome: VerifyAttempt; detail: string } {
  const prefix = steps.filter(step => step.index < failingIndex);
  const failing = [...steps].reverse().find(step => step.index === failingIndex);

  if (!failing){
    return { outcome: 'blocked', detail: 'Replay ended before the failing step.' };
  }

  const blockedAt = prefix.find(step => step.status === 'failed' || step.status === 'blocked');
  if (blockedAt){
    const why = blockedAt.error || blockedAt.observation || 'no detail';
    return {
      outcome: 'blocked',
      detail: `Could not reach step ${failingIndex}: step ${blockedAt.index} ${blockedAt.status} (${why}).`,
    };
  }

  const healed = steps.some(step => step.index <= failingIndex && step.resolution === 'healed');

  // The recorded element is gone, so the original action never ran. That is
  // "could not reach the state", not a reproduction of the original bug.
  if (failing.status === 'failed' && isLocatorMismatch(failing)){
    return {
      outcome: 'blocked',
      detail: failing.observation || 'Recorded locator no longer matches, so the failing step could not be replayed.',
    };
  }

  if (failing.status === 'failed'){
    const why = failing.observation || failing.error || 'The failing step failed again.';
    return {
      outcome: 'still_broken',
      detail: healed
        ? `Failure still occurs after re-resolving a stale locator. ${why}`
        : why,
    };
  }

  if (healed){
    return {
      outcome: 'healed',
      detail: 'A stale locator was re-resolved and the original failure did not recur.',
    };
  }

  if (failing.status === 'passed' || failing.status === 'skipped'){
    return { outcome: 'fixed', detail: 'The original failure did not recur.' };
  }

  return { outcome: 'blocked', detail: `Failing step finished as ${failing.status}.` };
}

function isLocatorMismatch(step: TraceStep): boolean {
  const blob = `${step.error || ''} ${step.observation || ''}`.toLowerCase();
  return blob.includes('locator_mismatch') || blob.includes('no longer matches');
}

export function aggregateVerdict(attempts: VerifyAttempt[]): VerifyVerdict {
  if (attempts.length === 0) return 'blocked';
  const fails = attempts.filter(attempt => attempt === 'still_broken').length;
  const heals = attempts.filter(attempt => attempt === 'healed').length;
  const passes = attempts.filter(attempt => attempt === 'fixed').length;
  if (fails === attempts.length) return 'still_broken';
  if (fails > 0) return 'flaky';
  if (heals > 0) return 'healed';
  if (passes === attempts.length) return 'fixed';
  return 'blocked';
}

/** Non-zero only when a bug fired (`still_broken` or `flaky`). */
export function verifyExitCode(report: { results: { verdict: VerifyVerdict }[] }): 0 | 1 {
  return report.results.some(result => result.verdict === 'still_broken' || result.verdict === 'flaky')
    ? 1
    : 0;
}
