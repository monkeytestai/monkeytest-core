/**
 * The Live e2e OpenAI job runs:
 *   monkeytest run <fixture> --provider openai --model gpt-4o-mini --max 3 --flows 4 --json
 *
 * That command enables strict oracles and fail-on-5xx. This test drives the
 * same depth with a model that only plans "read the homepage" and refuses to
 * resolve steps, and still expects the four seeded signals. Exit 1 is the
 * CLI's reaction to any blocking (non-minor) bug.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { explore } from '../../src/explorer/index.js';
import type { LLM } from '../../src/llm/index.js';
import { resolveMonkeyOracles } from '../../src/monkey.js';
import { plan } from '../../src/planner/index.js';
import { runPlan } from '../../src/runner/index.js';
import { triage } from '../../src/triager/index.js';
import type { RunResult } from '../../src/types.js';
import { startDemoServer, type DemoServer } from '../fixtures/demo-app/server.ts';

const SEEDED = ['page-error', 'http-4xx', 'http-5xx', 'element-disabled'] as const;

describe('live fixture path', () => {
  let demo: DemoServer;
  const shots = mkdtempSync(join(tmpdir(), 'monkeytest-live-fixture-'));
  const labels: string[] = [];

  const llm: LLM = {
    providerLabel: 'stub',
    async generateJSON({ label }) {
      labels.push(label || '');
      if (label === 'runner.resolveAction') {
        throw new Error('runner model must not be required for a grounded step');
      }
      if (label === 'explorer.summarisePage') {
        return { summary: 'A page in the corner shop.', authGated: false, interactive: [] };
      }
      if (label === 'explorer.summariseSite') {
        return {
          siteType: 'ecommerce',
          summary: 'A corner shop with checkout and a contact form.',
          productName: 'Corner shop',
          publicJourneys: ['Check out and send a message'],
          authSurfaces: [],
        };
      }
      if (label === 'planner.generate') {
        return {
          flows: [{
            id: 'read-home',
            name: 'Read the homepage',
            description: 'Read the shop homepage copy.',
            kind: 'happy_path',
            startUrl: demo.url,
            steps: [{ action: 'Read the introductory paragraph on the page', expectation: 'The page is readable.' }],
            expectation: 'The homepage is readable.',
            severityIfFails: 'minor',
          }],
          notes: 'Homepage only.',
        };
      }
      throw new Error(`unexpected LLM label ${label}`);
    },
  };

  beforeAll(async () => {
    demo = await startDemoServer({ mode: 'buggy' });
  });

  afterAll(async () => {
    await demo.close();
  });

  it('exits with blocking seeded bugs at --max 3 --flows 4 even when the model noops', async () => {
    const oracles = resolveMonkeyOracles({});
    expect(oracles).toEqual({ strictOracles: true, failOn5xx: true });

    const siteMap = await explore(demo.url, llm, {
      maxPages: 3,
      headless: true,
      screenshotsDir: shots,
    });
    expect(siteMap.pages.map(page => new URL(page.url).pathname).sort()).toEqual(['/', '/checkout', '/contact']);
    expect(siteMap.failedUrls).toEqual([]);

    const testPlan = await plan(siteMap, llm, { maxFlows: 4 });
    const actions = testPlan.flows.flatMap(flow => flow.steps.map(step => step.action)).join('\n');
    for (const label of ['Send message', 'Save order', 'Track shipment', 'Apply coupon']) {
      expect(actions).toContain(label);
    }

    const raw = await runPlan(testPlan, llm, {
      screenshotsDir: shots,
      headless: true,
      recordVideo: false,
      strictOracles: oracles.strictOracles,
      failOn5xx: oracles.failOn5xx,
    });
    const run = triage(raw, { failOn5xx: oracles.failOn5xx });
    const signals = seededSignals(run);
    expect(signals).toEqual([...SEEDED].sort());
    expect(run.bugs.filter(bug => bug.severity !== 'minor').length).toBeGreaterThanOrEqual(2);
    expect(labels).not.toContain('runner.resolveAction');

    const quietOracles = resolveMonkeyOracles({ strictOracles: false, failOn5xx: false });
    expect(quietOracles).toEqual({ strictOracles: false, failOn5xx: false });
    const quietRaw = await runPlan(testPlan, llm, {
      screenshotsDir: shots,
      headless: true,
      recordVideo: false,
      stepTimeoutMs: 2_500,
      strictOracles: quietOracles.strictOracles,
      failOn5xx: quietOracles.failOn5xx,
    });
    const quiet = triage(quietRaw);
    expect(seededSignals(quiet)).toEqual([]);
    expect(quiet.bugs.filter(bug => bug.severity !== 'minor')).toHaveLength(0);
  }, 180_000);
});

function seededSignals(run: RunResult): string[] {
  return [...new Set(
    run.bugs
      .map(bug => bug.fingerprintParts?.errorSignal || '')
      .filter(signal => (SEEDED as readonly string[]).includes(signal)),
  )].sort();
}
