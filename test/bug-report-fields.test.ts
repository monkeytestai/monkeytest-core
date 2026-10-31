/**
 * Optional report fields added in 0.6.1. They must not change fingerprint
 * hashes, and older bugs that omit them still load.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffRuns } from '../src/diff/index.js';
import { loadRun, saveRun } from '../src/persistence/index.js';
import { legacyFingerprint } from '../src/trace/fingerprint.js';
import { fallbackImpact, triage, triagePolished } from '../src/triager/index.js';
import type { BugReport, FlowResult, RunResult, StepResult } from '../src/types.js';

const PAGE_ERROR = 'pageerror: Cannot read properties of undefined';

describe('bug report fields', () => {
  it('adds impact, page_url, step_index, and flow_id without changing fingerprints', () => {
    const run = triage(runWith(failedStep(PAGE_ERROR)));
    const bug = run.bugs[0];
    expect(bug.fingerprint).toBe(legacyFingerprint({
      action: 'Press save',
      tool: 'click',
      error: PAGE_ERROR,
    }));
    expect(bug.fingerprintV2).toBeTruthy();
    expect(bug.flow_id).toBe('checkout');
    expect(bug.step_index).toBe(1);
    expect(bug.page_url).toBe('https://shop.example/checkout');
    expect(bug.impact).toMatch(/page error/i);
    expect(bug.impact).toMatch(/Save/);
    expect(bug.element).toEqual({ selector: 'button:Save' });
  });

  it('copies a bounding box captured on the step and leaves the hash alone', () => {
    const step = failedStep('http-500');
    step.observation = 'POST /api/contact returned HTTP 500.';
    step.element = {
      selector: 'button:Save',
      bounding_box: { x: 12, y: 40, width: 88, height: 24 },
    };
    const before = legacyFingerprint({ action: step.action, tool: step.tool, error: step.error });
    const bug = triage(runWith(step)).bugs[0];
    expect(bug.fingerprint).toBe(before);
    expect(bug.element).toEqual(step.element);
    expect(bug.impact).toMatch(/server returned an error/i);
    expect(bug.step_index).toBe(1);
    expect(bug.flow_id).toBe(runWith(step).flows[0].flowId);
  });

  it('keeps the deterministic impact when polish omits one, and uses the model line when present', async () => {
    const base = triage(runWith(failedStep(PAGE_ERROR)));
    const kept = await triagePolished(base, {
      llm: {
        providerLabel: 'stub',
        async generateJSON() {
          return {
            title: 'Checkout: save throws a page error',
            observed: 'The save control threw a page error.',
            expected: 'Save completes without a page error.',
            triageNotes: 'Look at the save handler.',
          };
        },
      },
    });
    expect(kept.bugs[0].impact).toBe(base.bugs[0].impact);
    expect(kept.bugs[0].fingerprint).toBe(base.bugs[0].fingerprint);
    expect(kept.bugs[0].fingerprintV2).toBe(base.bugs[0].fingerprintV2);
    expect(kept.bugs[0].flow_id).toBe('checkout');

    const rewritten = await triagePolished(base, {
      llm: {
        providerLabel: 'stub',
        async generateJSON() {
          return {
            title: 'Checkout: save throws a page error',
            observed: 'The save control threw a page error.',
            expected: 'Save completes without a page error.',
            triageNotes: 'Look at the save handler.',
            impact: "Shoppers can't save the order",
          };
        },
      },
    });
    expect(rewritten.bugs[0].impact).toBe("Shoppers can't save the order");
    expect(rewritten.bugs[0].fingerprint).toBe(base.bugs[0].fingerprint);
    expect(rewritten.bugs[0].page_url).toBe(base.bugs[0].page_url);
    expect(rewritten.bugs[0].step_index).toBe(base.bugs[0].step_index);
  });

  it('round-trips through a saved run and still diffs on the old fingerprint', () => {
    const current = triage(runWith(failedStep(PAGE_ERROR)));
    const previous = triage(runWith(failedStep(PAGE_ERROR)));
    previous.bugs[0] = { ...previous.bugs[0], impact: 'A different impact line.' };
    const diff = diffRuns(previous, current);
    expect(diff.persistingBugs).toHaveLength(1);
    expect(diff.persistingBugs[0].fingerprint).toBe(current.bugs[0].fingerprintV2);
    expect(diff.newBugs).toHaveLength(0);
    expect(diff.persistingBugs[0].bug.impact).toBe(current.bugs[0].impact);

    const dir = mkdtempSync(join(tmpdir(), 'monkeytest-bug-fields-'));
    const saved = saveRun(current, { dir });
    const loaded = loadRun(saved.path);
    expect(loaded.run.bugs[0].flow_id).toBe('checkout');
    expect(loaded.run.bugs[0].step_index).toBe(1);
    expect(loaded.run.bugs[0].page_url).toBe('https://shop.example/checkout');
    expect(loaded.run.bugs[0].impact).toBe(current.bugs[0].impact);
    expect(loaded.run.bugs[0].fingerprint).toBe(current.bugs[0].fingerprint);
    expect(loaded.run.bugs[0].fingerprintV2).toBe(current.bugs[0].fingerprintV2);
  });

  it('builds a one-line fallback from the failure kind', () => {
    const flow = runWith(failedStep('element-disabled')).flows[0];
    const step = flow.steps[1];
    expect(fallbackImpact(flow, { ...step, error: 'element-disabled', observation: 'control is disabled' }))
      .toMatch(/disabled/i);
  });
});

function failedStep(error: string): StepResult {
  return {
    index: 2,
    action: 'Press save',
    expectation: 'The form submits',
    status: 'failed',
    observation: error,
    tool: 'click',
    target: 'button:Save',
    locator: { strategy: 'css', target: 'button:Save', css: 'button:Save' },
    error,
    screenshotPath: '/tmp/shot.png',
  };
}

function runWith(step: StepResult): RunResult {
  const flow: FlowResult = {
    flowId: 'checkout',
    name: 'Checkout',
    description: 'Pay',
    kind: 'happy_path',
    startUrl: 'https://shop.example/checkout',
    status: 'failed',
    steps: [
      { index: 1, action: 'Open cart', status: 'passed', observation: 'Opened.' },
      step,
    ],
    durationMs: 10,
    bugIds: [],
    trace: {
      version: 1,
      flowId: 'checkout',
      name: 'Checkout',
      startUrl: 'https://shop.example/checkout',
      steps: [
        {
          index: 0,
          tool: 'goto',
          status: 'passed',
          locator: { strategy: 'css', target: 'https://shop.example/checkout' },
          urlAfter: 'https://shop.example/checkout',
        },
        {
          index: 2,
          tool: 'click',
          status: 'failed',
          action: 'Press save',
          error: step.error,
          locator: { strategy: 'role', target: 'button:Save', role: 'button', name: 'Save' },
          urlBefore: 'https://shop.example/checkout',
          urlAfter: 'https://shop.example/checkout',
        },
      ],
    },
  };
  return {
    startUrl: flow.startUrl,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    flows: [flow],
    bugs: [] as BugReport[],
    stats: {
      flowsTotal: 1, flowsPassed: 0, flowsFailed: 1, flowsBlocked: 0,
      stepsTotal: 2, stepsPassed: 1, stepsFailed: 1,
      bugsCritical: 0, bugsMajor: 0, bugsMinor: 0,
    },
  };
}
