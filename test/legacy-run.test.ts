import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadRun } from '../src/persistence/index.js';
import { verifyBugs } from '../src/verify/index.js';

describe('legacy run files', () => {
  it('loads a schema-1 run that has no traces and reports the bug blocked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'monkeytest-legacy-'));
    const id = '2020-01-01T00-00-00Z';
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({
      schema: 1,
      createdAt: '2020-01-01T00:00:00.000Z',
      id,
      run: {
        startUrl: 'https://example.com',
        startedAt: '2020-01-01T00:00:00.000Z',
        finishedAt: '2020-01-01T00:00:01.000Z',
        flows: [{
          flowId: 'home',
          name: 'Home',
          description: 'Visit',
          kind: 'happy_path',
          startUrl: 'https://example.com',
          status: 'failed',
          steps: [{
            index: 1,
            action: 'Click more',
            status: 'failed',
            observation: 'Click failed',
            tool: 'click',
            error: 'Timeout 15000ms exceeded',
          }],
          durationMs: 20,
          bugIds: ['bug-old'],
        }],
        bugs: [{
          id: 'bug-old',
          fingerprint: 'legacy-deadbeef',
          title: 'Home: Click more',
          severity: 'major',
          affectedFlow: 'Home',
          reproSteps: ['Open https://example.com', 'Click more'],
          observed: 'Click failed',
          expected: 'The click works',
          evidence: { screenshots: [], consoleErrors: [], networkFailures: [] },
          triageNotes: 'Old fingerprint.',
        }],
        stats: {
          flowsTotal: 1, flowsPassed: 0, flowsFailed: 1, flowsBlocked: 0,
          stepsTotal: 1, stepsPassed: 0, stepsFailed: 1,
          bugsCritical: 0, bugsMajor: 1, bugsMinor: 0,
        },
      },
    }));

    const stored = loadRun(join(dir, `${id}.json`));
    expect(stored.run.bugs[0].fingerprint).toBe('legacy-deadbeef');
    expect(stored.run.flows[0].trace).toBeUndefined();

    const report = await verifyBugs(stored.run, { screenshotsDir: dir, repeat: 2 });
    expect(report.results).toHaveLength(1);
    expect(report.results[0].verdict).toBe('blocked');
    expect(report.results[0].attempts).toEqual(['blocked', 'blocked']);
    expect(report.exitCode).toBe(0);
    expect(report.results[0].detail).toMatch(/no trace/i);
  });
});
