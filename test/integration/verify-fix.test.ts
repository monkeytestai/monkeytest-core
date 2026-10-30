/**
 * End-to-end: a local page with a deliberate product bug (a disabled Place
 * order button), a stub LLM, then a fixed page. `verify` must report the bug
 * fixed and must not call the LLM while doing it.
 *
 * A non-editable stand-in (`div role=textbox`) is a runner miss and is not a
 * bug. This fixture uses a disabled control, which strict oracles still file.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { diffRuns } from '../../src/diff/index.js';
import type { LLM } from '../../src/llm/index.js';
import { saveRun } from '../../src/persistence/index.js';
import { runPlan } from '../../src/runner/index.js';
import { triage } from '../../src/triager/index.js';
import type { RunResult, TestPlan } from '../../src/types.js';
import { verifyBugs } from '../../src/verify/index.js';

type Mode = 'buggy' | 'fixed' | 'renamed';

function page(mode: Mode): string {
  const renamed = mode === 'renamed';
  const label = renamed ? 'Submit order' : 'Place order';
  const id = renamed ? 'submit' : 'place';
  const disabled = mode === 'buggy' ? ' disabled' : '';
  return `<!doctype html>
<html><head><title>Checkout</title></head>
<body>
  <h1>Checkout</h1>
  <p>Review the order, then place it.</p>
  <button type="button" id="${id}"${disabled}>${label}</button>
</body></html>`;
}

describe('verify reports a fixed bug', () => {
  let server: Server;
  let mode: Mode = 'buggy';
  let baseUrl = '';
  const shots = mkdtempSync(join(tmpdir(), 'monkeytest-shots-'));
  const store = mkdtempSync(join(tmpdir(), 'monkeytest-store-'));
  const llmCalls: string[] = [];

  const llm: LLM = {
    providerLabel: 'stub',
    async generateJSON({ label, prompt }) {
      llmCalls.push(label || '');
      if (label !== 'runner.resolveAction') throw new Error(`unexpected LLM label ${label}`);
      const text = String(prompt);
      if (text.includes('Submit order')) {
        return {
          tool: 'click',
          target: 'button:Submit order',
          locator: 'role',
          rationale: 'The order button was renamed.',
        };
      }
      return {
        tool: 'click',
        target: 'button:Place order',
        locator: 'role',
        rationale: 'Place the order.',
      };
    },
  };

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page(mode));
    });
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve());
      server.once('error', reject);
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}/`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  });

  it('replays the recorded trace and reports fixed after the fixture is corrected', async () => {
    mode = 'buggy';
    const first = await execute(baseUrl, shots, llm);
    const second = await execute(baseUrl, shots, llm);

    expect(first.bugs).toHaveLength(1);
    expect(second.bugs[0].fingerprint).toBe(first.bugs[0].fingerprint);
    expect(diffRuns(first, second).stats).toMatchObject({ new: 0, fixed: 0, persisting: 1, regressed: 0 });

    const bug = first.bugs[0];
    expect(bug.fingerprintParts).toMatchObject({
      version: 2,
      category: 'interaction',
      role: 'button',
      name: 'place order',
      errorSignal: 'element-disabled',
    });
    expect(bug.fingerprintParts?.location.startsWith(baseUrl.replace(/\/$/, ''))).toBe(true);
    expect(JSON.stringify(bug.fingerprintParts)).not.toContain('click');
    expect(bug.trace?.steps.map(step => step.tool)).toEqual(['goto', 'click']);
    expect(bug.trace?.steps[1]).toMatchObject({
      status: 'failed',
      locator: { role: 'button', name: 'Place order' },
    });
    expect(bug.evidence.screenshots.length).toBeGreaterThan(0);

    const saved = saveRun(first, { dir: store });
    const callsBeforeVerify = llmCalls.length;

    const still = await verifyBugs(first, {
      screenshotsDir: shots,
      repeat: 1,
      headless: true,
      recordVideo: false,
      strictOracles: true,
      llm,
    });
    expect(still.results[0].verdict).toBe('still_broken');
    expect(still.exitCode).toBe(1);
    expect(llmCalls.length).toBe(callsBeforeVerify);

    const brokenCli = await runCli(['verify', saved.id, '--dir', store, '--json', '--repeat', '1']);
    expect(brokenCli.code).toBe(1);
    const brokenReport = JSON.parse(brokenCli.stdout);
    expect(brokenReport.results[0].verdict).toBe('still_broken');

    mode = 'fixed';
    const fixed = await verifyBugs(first, {
      screenshotsDir: shots,
      repeat: 1,
      headless: true,
      recordVideo: false,
      strictOracles: true,
      llm,
    });
    expect(fixed.results[0].verdict).toBe('fixed');
    expect(fixed.results[0].fired).toBe(0);
    expect(fixed.exitCode).toBe(0);
    expect(llmCalls.length).toBe(callsBeforeVerify);

    const fixedCli = await runCli(['verify', saved.id, '--dir', store, '--json']);
    expect(fixedCli.code).toBe(0);
    const fixedReport = JSON.parse(fixedCli.stdout);
    expect(fixedReport.results[0].verdict).toBe('fixed');
    expect(fixedReport.exitCode).toBe(0);

    mode = 'renamed';
    const blocked = await verifyBugs(first, {
      screenshotsDir: shots,
      headless: true,
      recordVideo: false,
      strictOracles: true,
    });
    expect(blocked.results[0].verdict).toBe('blocked');
    expect(blocked.exitCode).toBe(0);

    const healed = await verifyBugs(first, {
      screenshotsDir: shots,
      headless: true,
      recordVideo: false,
      strictOracles: true,
      heal: true,
      llm,
    });
    expect(healed.results[0].verdict).toBe('healed');
    expect(healed.exitCode).toBe(0);
    expect(llmCalls.length).toBeGreaterThan(callsBeforeVerify);
  }, 120_000);
});

async function execute(url: string, shots: string, llm: LLM): Promise<RunResult> {
  const plan: TestPlan = {
    startUrl: url,
    siteType: 'fixture',
    flows: [{
      id: 'checkout',
      name: 'Checkout',
      description: 'Place the order',
      kind: 'happy_path',
      startUrl: url,
      expectation: 'The order button can be used',
      severityIfFails: 'major',
      steps: [{
        action: 'Click "Place order"',
        expectation: 'The order button is enabled.',
      }],
    }],
  };
  const raw = await runPlan(plan, llm, {
    screenshotsDir: shots,
    headless: true,
    recordVideo: false,
    strictOracles: true,
    stepTimeoutMs: 5_000,
  });
  return triage(raw);
}

function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const root = fileURLToPath(new URL('../..', import.meta.url));
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: root,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
