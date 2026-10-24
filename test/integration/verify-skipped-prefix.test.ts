/**
 * Live e2e on gpt-4o-mini (run 40075464666) filed http-5xx on the contact
 * form after a placeholder fill timed out and was skipped. Replay treated
 * that miss as locator_mismatch, so verify reported the 500 as blocked on
 * both the buggy and fixed fixture (seededFixed 2/3). A skipped prefix must
 * stay skipped. A prefix that originally passed still blocks the flow.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { replayTraces } from '../../src/runner/replay.js';
import type { BugReport, RunResult, TraceStep } from '../../src/types.js';
import { verifyBugs } from '../../src/verify/index.js';
import { startDemoServer, type DemoServer } from '../fixtures/demo-app/server.ts';

describe('verify after a skipped prefix step', () => {
  let demo: DemoServer;
  const shots = mkdtempSync(join(tmpdir(), 'monkeytest-skipped-prefix-'));

  beforeAll(async () => {
    demo = await startDemoServer({ mode: 'buggy' });
  });

  afterAll(async () => {
    await demo.close();
  });

  it('reaches the HTTP 500 and reports it fixed once the form succeeds', async () => {
    const posted = await fetch(`${demo.url}/__monkeytest/mode`, { method: 'POST', body: 'buggy' });
    expect(posted.status).toBe(204);
    const run = contactRun(demo.url, 'skipped');

    const replay = await replayTraces([traceOf(run)], {
      screenshotsDir: shots,
      headless: true,
      recordVideo: false,
      strictOracles: true,
      failOn5xx: true,
    });
    expect(replay.flows[0].steps.map(step => step.status)).toEqual(['passed', 'skipped', 'failed']);
    expect(replay.flows[0].steps[2].error).toBe('http-500');

    const still = await verifyBugs(run, {
      screenshotsDir: shots,
      headless: true,
      recordVideo: false,
      strictOracles: true,
      failOn5xx: true,
    });
    expect(still.results[0].verdict).toBe('still_broken');
    expect(still.results[0].detail.toLowerCase()).toContain('500');
    expect(still.exitCode).toBe(1);

    const flipped = await fetch(`${demo.url}/__monkeytest/mode`, { method: 'POST', body: 'fixed' });
    expect(flipped.status).toBe(204);

    const fixed = await verifyBugs(run, {
      screenshotsDir: shots,
      headless: true,
      recordVideo: false,
      strictOracles: true,
      failOn5xx: true,
    });
    expect(fixed.results[0].verdict).toBe('fixed');
    expect(fixed.results[0].detail).toBe('The original failure did not recur.');
    expect(fixed.exitCode).toBe(0);
    expect(fixed.stats.blocked).toBe(0);
    expect(fixed.stats.still_broken).toBe(0);
    expect(fixed.stats.flaky).toBe(0);
  }, 60_000);

  it('still blocks when a prefix step that originally passed no longer matches', async () => {
    const posted = await fetch(`${demo.url}/__monkeytest/mode`, { method: 'POST', body: 'buggy' });
    expect(posted.status).toBe(204);
    const run = contactRun(demo.url, 'passed');

    const replay = await replayTraces([traceOf(run)], {
      screenshotsDir: shots,
      headless: true,
      recordVideo: false,
      strictOracles: true,
      failOn5xx: true,
    });
    expect(replay.flows[0].steps.map(step => step.status)).toEqual(['passed', 'failed', 'blocked']);
    expect(replay.flows[0].steps[1].error).toBe('locator_mismatch');

    const report = await verifyBugs(run, {
      screenshotsDir: shots,
      headless: true,
      recordVideo: false,
      strictOracles: true,
      failOn5xx: true,
    });
    expect(report.results[0].verdict).toBe('blocked');
    expect(report.results[0].detail.toLowerCase()).toContain('failing step');
    expect(report.exitCode).toBe(0);
    expect(report.stats.fixed).toBe(0);
    expect(report.stats.still_broken).toBe(0);
  }, 60_000);
});

function traceOf(run: RunResult) {
  const bug = run.bugs[0];
  return {
    version: 1 as const,
    flowId: bug.trace!.flowId,
    name: 'Submit a contact inquiry',
    startUrl: bug.trace!.startUrl,
    steps: bug.trace!.steps,
  };
}

function contactRun(origin: string, fillStatus: 'skipped' | 'passed'): RunResult {
  const contact = `${origin}/contact`;
  const fill: TraceStep = {
    index: 1,
    action: "input 'Email'",
    tool: 'fill',
    status: fillStatus,
    observation: fillStatus === 'skipped'
      ? "Fill on placeholder:Email could not be completed by the agent (locator.fill: Timeout 15000ms exceeded.). Treated as inconclusive rather than a product bug."
      : 'Typed into placeholder:Email.',
    locator: {
      strategy: 'placeholder',
      target: 'Email',
      name: 'Email',
      placeholder: 'Email',
    },
  };
  const steps: TraceStep[] = [
    {
      index: 0,
      action: `Open ${contact}`,
      tool: 'goto',
      status: 'passed',
      observation: `Navigated to ${contact}.`,
      locator: { strategy: 'css', target: contact },
    },
    fill,
    {
      index: 2,
      action: "button 'Send message'",
      tool: 'click',
      status: 'failed',
      error: 'http-500',
      observation: 'Clicked role:button:Send message. POST /api/contact returned HTTP 500.',
      locator: {
        strategy: 'role',
        target: 'button:Send message',
        role: 'button',
        name: 'Send message',
        testId: 'send-message',
      },
    },
  ];
  const bug: BugReport = {
    id: 'bug-contact-form-submit-2',
    fingerprint: '81360c3a479cf43a',
    fingerprintV2: '581f35a57d26a1df',
    fingerprintParts: {
      version: 2,
      category: 'network',
      location: contact,
      role: 'button',
      name: 'send message',
      errorSignal: 'http-5xx',
    },
    trace: { version: 1, flowId: 'contact-form-submit', startUrl: contact, steps },
    title: "Submit a contact inquiry: button 'Send message'",
    severity: 'critical',
    affectedFlow: 'Submit a contact inquiry',
    reproSteps: [`Open ${contact}`, "input 'Email'", "button 'Send message'"],
    observed: 'POST /api/contact returned HTTP 500.',
    expected: 'The form submits without a server error.',
    evidence: { screenshots: [], consoleErrors: [], networkFailures: [] },
    triageNotes: 'The runner attempted a click on button:Send message. Underlying error: http-500.',
  };
  return {
    startUrl: origin,
    startedAt: '2026-10-24T07:48:43.000Z',
    finishedAt: '2026-10-24T07:48:43.000Z',
    flows: [{
      flowId: 'contact-form-submit',
      name: 'Submit a contact inquiry',
      description: 'Submit the contact form.',
      kind: 'happy_path',
      startUrl: contact,
      status: 'failed',
      failureReason: 'http-500',
      steps: [],
      durationMs: 1,
      bugIds: [bug.id],
      trace: { version: 1, flowId: 'contact-form-submit', name: 'Submit a contact inquiry', startUrl: contact, steps },
    }],
    bugs: [bug],
    stats: {
      flowsTotal: 1,
      flowsPassed: 0,
      flowsFailed: 1,
      flowsBlocked: 0,
      stepsTotal: 2,
      stepsPassed: 0,
      stepsFailed: 1,
      bugsCritical: 1,
      bugsMajor: 0,
      bugsMinor: 0,
    },
  };
}
