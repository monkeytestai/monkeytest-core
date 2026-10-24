/**
 * Layer 1: the shared demo fixture, a stub LLM, and verify.
 * No provider key is read. The live workflow in .github/workflows/e2e-live.yml
 * drives the same server with a real model.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LLM } from '../../src/llm/index.js';
import { runPlan } from '../../src/runner/index.js';
import { triage } from '../../src/triager/index.js';
import type { RunResult, TestPlan } from '../../src/types.js';
import { verifyBugs } from '../../src/verify/index.js';
import { startDemoServer, type DemoServer } from '../fixtures/demo-app/server.ts';

describe('demo app seeded bugs', () => {
  let demo: DemoServer;
  const shots = mkdtempSync(join(tmpdir(), 'monkeytest-demo-'));
  const llmCalls: string[] = [];

  const llm: LLM = {
    providerLabel: 'stub',
    async generateJSON({ label, prompt }) {
      llmCalls.push(label || '');
      if (label !== 'runner.resolveAction') throw new Error(`unexpected LLM label ${label}`);
      return actionFor(String(prompt));
    },
  };

  beforeAll(async () => {
    demo = await startDemoServer({ mode: 'buggy' });
  });

  afterAll(async () => {
    await demo.close();
  });

  it('leaves the seeded failures unreported when strict oracles and fail-on-5xx are off', async () => {
    await fetch(`${demo.url}/__monkeytest/mode`, { method: 'POST', body: 'buggy' });
    const run = await execute(demo.url, shots, llm, false);
    expect(run.bugs).toHaveLength(0);
    expect(run.stats.flowsFailed).toBe(0);
  }, 60_000);

  it('promotes a same-origin HTTP 500 into a blocking bug without the other strict oracles', async () => {
    await fetch(`${demo.url}/__monkeytest/mode`, { method: 'POST', body: 'buggy' });
    const run = await execute(demo.url, shots, llm, false, true, 'send-message');
    expect(run.bugs).toHaveLength(1);
    expect(run.bugs[0].severity).toBe('critical');
    expect(run.bugs[0].fingerprintParts).toMatchObject({
      category: 'network',
      errorSignal: 'http-5xx',
    });
    expect(run.flows[0].status).toBe('failed');
    expect(run.flows[0].steps.some(step => step.status === 'failed' && step.error === 'http-500')).toBe(true);
    expect(run.stats.flowsFailed).toBe(1);
    expect(run.stats.bugsCritical).toBe(1);
  }, 60_000);

  it('finds each seeded category and reports them fixed once the same app is corrected', async () => {
    const posted = await fetch(`${demo.url}/__monkeytest/mode`, { method: 'POST', body: 'buggy' });
    expect(posted.status).toBe(204);
    expect(demo.getMode()).toBe('buggy');

    const run = await execute(demo.url, shots, llm, true);
    expect(run.bugs).toHaveLength(4);

    const found = Object.fromEntries(run.bugs.map(bug => [
      bug.fingerprintParts?.errorSignal,
      bug.fingerprintParts?.category,
    ]));
    expect(found).toEqual({
      'page-error': 'page-error',
      'http-4xx': 'navigation',
      'http-5xx': 'network',
      'element-disabled': 'interaction',
    });

    const callsBeforeVerify = llmCalls.length;
    const still = await verifyBugs(run, {
      screenshotsDir: shots,
      headless: true,
      recordVideo: false,
      llm,
      strictOracles: true,
    });
    expect(still.results.map(result => result.verdict).sort()).toEqual([
      'still_broken', 'still_broken', 'still_broken', 'still_broken',
    ]);
    expect(still.exitCode).toBe(1);
    expect(llmCalls.length).toBe(callsBeforeVerify);

    const fixedMode = await fetch(`${demo.url}/__monkeytest/mode`, { method: 'POST', body: 'fixed' });
    expect(fixedMode.status).toBe(204);
    expect(demo.getMode()).toBe('fixed');

    const fixed = await verifyBugs(run, {
      screenshotsDir: shots,
      headless: true,
      recordVideo: false,
      llm,
      strictOracles: true,
    });
    expect(fixed.results.map(result => result.verdict).sort()).toEqual([
      'fixed', 'fixed', 'fixed', 'fixed',
    ]);
    expect(fixed.exitCode).toBe(0);
    expect(llmCalls.length).toBe(callsBeforeVerify);
  }, 120_000);
});

function actionFor(prompt: string) {
  const step = prompt.match(/^\s*Step:\s+(.+)$/m)?.[1] ?? '';
  if (step.includes('Save order')) {
    return { tool: 'click', locator: 'role', target: 'button:Save order', rationale: 'Save the order.' };
  }
  if (step.includes('Track shipment')) {
    return { tool: 'click', locator: 'role', target: 'link:Track shipment', rationale: 'Open tracking.' };
  }
  if (step.includes('Send message')) {
    return { tool: 'click', locator: 'role', target: 'button:Send message', rationale: 'Submit the form.' };
  }
  if (step.includes('Apply coupon')) {
    return { tool: 'click', locator: 'role', target: 'button:Apply coupon', rationale: 'Apply the coupon.' };
  }
  throw new Error(`stub LLM has no action for step "${step}"`);
}

async function execute(
  url: string,
  shots: string,
  llm: LLM,
  strictOracles: boolean,
  failOn5xx = false,
  only?: string,
): Promise<RunResult> {
  const flows = [
    flow('save-order', 'Save the order', `${url}/checkout`, 'Click Save order'),
    flow('track-shipment', 'Track the shipment', `${url}/checkout`, 'Click Track shipment'),
    flow('send-message', 'Send a message', `${url}/contact`, 'Click Send message'),
    flow('apply-coupon', 'Apply a coupon', `${url}/checkout`, 'Click Apply coupon'),
  ];
  const plan: TestPlan = {
    startUrl: url,
    siteType: 'fixture',
    flows: only ? flows.filter(item => item.id === only) : flows,
  };
  const raw = await runPlan(plan, llm, {
    screenshotsDir: shots,
    headless: true,
    recordVideo: false,
    stepTimeoutMs: strictOracles || failOn5xx ? 8_000 : 2_000,
    strictOracles,
    failOn5xx,
  });
  return triage(raw);
}

function flow(id: string, name: string, startUrl: string, action: string) {
  return {
    id,
    name,
    description: name,
    kind: 'happy_path' as const,
    startUrl,
    expectation: 'The control completes without an error.',
    severityIfFails: 'major' as const,
    steps: [{ action, expectation: 'The control completes without an error.' }],
  };
}
