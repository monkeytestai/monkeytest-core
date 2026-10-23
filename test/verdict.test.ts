import { describe, expect, it } from 'vitest';
import { aggregateVerdict, classifyAttempt, verifyExitCode } from '../src/verify/verdict.js';
import type { TraceStep } from '../src/types.js';

describe('classifyAttempt', () => {
  it('reports fixed when the failing step now passes', () => {
    const result = classifyAttempt([
      step(0, 'passed'),
      step(1, 'passed'),
    ], 1);
    expect(result.outcome).toBe('fixed');
  });

  it('reports still_broken when the failing step fails again', () => {
    const result = classifyAttempt([
      step(0, 'passed'),
      step(1, 'failed', { error: 'not editable' }),
    ], 1);
    expect(result.outcome).toBe('still_broken');
  });

  it('reports blocked when a prefix step never reaches the failure', () => {
    const result = classifyAttempt([
      step(0, 'failed', { error: 'navigation-failed' }),
      step(1, 'blocked'),
    ], 1);
    expect(result.outcome).toBe('blocked');
  });

  it('reports blocked when the failing step locator itself no longer matches', () => {
    const result = classifyAttempt([
      step(0, 'passed'),
      step(1, 'failed', { error: 'locator_mismatch' }),
    ], 1);
    expect(result.outcome).toBe('blocked');
  });

  it('reports healed when a re-resolved locator gets through and the bug does not recur', () => {
    const result = classifyAttempt([
      step(0, 'passed'),
      step(1, 'passed', { resolution: 'healed' }),
    ], 1);
    expect(result.outcome).toBe('healed');
  });

  it('stays still_broken when healing still reproduces the failure', () => {
    const result = classifyAttempt([
      step(0, 'passed', { resolution: 'healed' }),
      step(1, 'failed', { error: 'not editable', resolution: 'healed' }),
    ], 1);
    expect(result.outcome).toBe('still_broken');
  });
});

describe('aggregateVerdict', () => {
  it('collapses repeats', () => {
    expect(aggregateVerdict(['still_broken', 'still_broken'])).toBe('still_broken');
    expect(aggregateVerdict(['fixed', 'fixed'])).toBe('fixed');
    expect(aggregateVerdict(['still_broken', 'fixed'])).toBe('flaky');
    expect(aggregateVerdict(['still_broken', 'blocked'])).toBe('flaky');
    expect(aggregateVerdict(['healed', 'fixed'])).toBe('healed');
    expect(aggregateVerdict(['blocked', 'blocked'])).toBe('blocked');
    expect(aggregateVerdict(['blocked', 'fixed'])).toBe('blocked');
    expect(aggregateVerdict([])).toBe('blocked');
  });
});

describe('verifyExitCode', () => {
  it('is non-zero only when a bug fired', () => {
    expect(verifyExitCode({ results: [{ verdict: 'fixed' }, { verdict: 'healed' }, { verdict: 'blocked' }] })).toBe(0);
    expect(verifyExitCode({ results: [{ verdict: 'still_broken' }] })).toBe(1);
    expect(verifyExitCode({ results: [{ verdict: 'flaky' }] })).toBe(1);
    expect(verifyExitCode({ results: [] })).toBe(0);
  });
});

function step(
  index: number,
  status: TraceStep['status'],
  extra: Partial<TraceStep> = {},
): TraceStep {
  return {
    index,
    tool: index === 0 ? 'goto' : 'fill',
    status,
    ...extra,
  };
}
