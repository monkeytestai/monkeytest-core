import { describe, expect, it } from 'vitest';
import { bugFingerprint, diffRuns, summariseDiff } from '../src/diff/index.js';
import { fingerprintFailure } from '../src/trace/fingerprint.js';
import type { BugReport, RunResult } from '../src/types.js';

describe('diffRuns', () => {
  it('treats two v2 bugs as the same bug when only the tool and volatile error text differ', () => {
    const click = fingerprintFailure({
      tool: 'click',
      error: 'Timeout 15000ms exceeded waiting for locator id=abc at 2024-01-01T00:00:00.000Z',
      location: 'https://shop.example/users/7',
      locator: { strategy: 'role', target: 'button:Save', role: 'button', name: 'Save' },
    });
    const fill = fingerprintFailure({
      tool: 'fill',
      error: 'Timeout 50ms exceeded waiting for locator id=zzz at 2025-02-02T00:00:00.000Z',
      location: 'https://shop.example/users/8',
      locator: { strategy: 'role', target: 'button:Save', role: 'button', name: 'Save' },
    });
    expect(fill.fingerprint).toBe(click.fingerprint);

    const diff = diffRuns(
      runOf([bug(click.fingerprint, 'major', click.parts)]),
      runOf([bug('this-stored-string-is-stale', 'major', fill.parts)]),
    );
    expect(diff.stats).toMatchObject({ new: 0, fixed: 0, persisting: 1, regressed: 0, delta: 0 });
    expect(diff.persistingBugs[0].fingerprint).toBe(click.fingerprint);
    expect(summariseDiff(diff)).toBe('0 new, 0 fixed, 1 still broken, 0 regressed (net 0)');
  });

  it('keeps legacy fingerprints when v2 parts are absent', () => {
    const previous = runOf([bug('legacy-abc', 'minor')]);
    const current = runOf([bug('legacy-abc', 'critical')]);
    const diff = diffRuns(previous, current);
    expect(bugFingerprint(previous.bugs[0])).toBe('legacy-abc');
    expect(diff.regressedBugs).toHaveLength(1);
    expect(diff.fixedBugs).toHaveLength(0);
    expect(diff.newBugs).toHaveLength(0);
  });

  it('reports fixed and new when the element identity changes', () => {
    const save = fingerprintFailure({
      tool: 'click',
      error: 'target not found waiting for locator',
      location: 'https://shop.example/checkout',
      locator: { strategy: 'role', target: 'button:Save', role: 'button', name: 'Save' },
    });
    const pay = fingerprintFailure({
      tool: 'click',
      error: 'target not found waiting for locator',
      location: 'https://shop.example/checkout',
      locator: { strategy: 'role', target: 'button:Pay', role: 'button', name: 'Pay' },
    });
    const diff = diffRuns(
      runOf([bug(save.fingerprint, 'major', save.parts)]),
      runOf([bug(pay.fingerprint, 'major', pay.parts)]),
    );
    expect(diff.stats.fixed).toBe(1);
    expect(diff.stats.new).toBe(1);
    expect(diff.stats.persisting).toBe(0);
  });
});

function bug(
  fingerprint: string,
  severity: BugReport['severity'],
  parts?: BugReport['fingerprintParts'],
): BugReport {
  return {
    id: `bug-${fingerprint}`,
    fingerprint,
    ...(parts ? { fingerprintParts: parts } : {}),
    title: 'Checkout failed',
    severity,
    affectedFlow: 'Checkout',
    reproSteps: ['Open /checkout'],
    observed: 'It failed',
    expected: 'It works',
    evidence: { screenshots: [], consoleErrors: [], networkFailures: [] },
    triageNotes: 'Look at the control.',
  };
}

function runOf(bugs: BugReport[]): RunResult {
  return {
    startUrl: 'https://shop.example',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    flows: [],
    bugs,
    stats: {
      flowsTotal: 1, flowsPassed: 0, flowsFailed: 1, flowsBlocked: 0,
      stepsTotal: 1, stepsPassed: 0, stepsFailed: 1,
      bugsCritical: bugs.filter(item => item.severity === 'critical').length,
      bugsMajor: bugs.filter(item => item.severity === 'major').length,
      bugsMinor: bugs.filter(item => item.severity === 'minor').length,
    },
  };
}
