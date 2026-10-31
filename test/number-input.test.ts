/**
 * The inputs example has one unlabeled number field. 0.6.0 waited 15s on
 * `label:Number Input` and on a bare `number`, and it also ran checkbox and
 * text-input flows the page does not have.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import type { LLM } from '../src/llm/index.js';
import { explore } from '../src/explorer/index.js';
import { plan } from '../src/planner/index.js';
import { executeAction } from '../src/runner/actions.js';
import { runPlan } from '../src/runner/index.js';
import { triage } from '../src/triager/index.js';
import type { SiteMap, TestFlow } from '../src/types.js';
import { INPUTS_MARKUP, startInputsServer, type InputsServer } from './fixtures/inputs-page.js';

const HTML = INPUTS_MARKUP;

describe('unlabeled number input', () => {
  it('fills label:Number Input and a bare number without waiting out the timeout', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(HTML);
      for (const action of [
        { tool: 'fill' as const, locator: 'label' as const, target: 'Number Input', value: '7' },
        { tool: 'fill' as const, target: 'number', value: '555-0100' },
      ]) {
        await page.locator('input[type=number]').fill('');
        const started = Date.now();
        const outcome = await executeAction(page, action, 15_000);
        expect(Date.now() - started).toBeLessThan(8_000);
        expect(outcome.status).toBe('passed');
        expect(outcome.observation).not.toMatch(/Timeout \d+ms exceeded/);
        expect(await page.locator('input[type=number]').inputValue()).toMatch(/^\d+$/);
      }
      expect(await page.locator('input[type=number]').inputValue()).toBe('5550100');
    } finally {
      await browser.close();
    }
  });

  it('fills an unlabeled text input from the preceding text when nothing else matches', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent('<h3>Details</h3><p>Quantity</p><input type="text">');
      const outcome = await executeAction(page, {
        tool: 'fill',
        target: 'Quantity',
        value: 'banana',
      }, 5_000);
      expect(outcome.status).toBe('passed');
      expect(await page.locator('input').inputValue()).toBe('banana');
      expect(outcome.observation).not.toMatch(/Timeout/);
    } finally {
      await browser.close();
    }
  });

  it('fails fast when the page has no checkbox', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(HTML);
      const started = Date.now();
      const outcome = await executeAction(page, {
        tool: 'fill',
        locator: 'label',
        target: 'Checkbox',
        value: 'yes',
      }, 15_000);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(outcome.status).toBe('skipped');
      expect(outcome.observation).toMatch(/no checkbox/i);
      expect(outcome.observation).not.toMatch(/Timeout \d+ms exceeded/);
      expect(await page.locator('input[type=number]').inputValue()).toBe('');
    } finally {
      await browser.close();
    }
  });

  it('drops checkbox and text-input flows and repairs the number flow', async () => {
    const llm: LLM = {
      providerLabel: 'stub',
      async generateJSON() {
        return { flows: [numberFlow(), textFlow(), checkboxFlow()], notes: 'Invented inputs.' };
      },
    };
    const result = await plan(inputsMap(), llm, { maxFlows: 4 });
    const blob = result.flows.map(flow => `${flow.name} ${flow.steps.map(step => step.action).join(' ')}`).join('\n');
    expect(blob.toLowerCase()).not.toMatch(/checkbox/);
    expect(blob.toLowerCase()).not.toMatch(/text input|text field|textbox/);
    expect(result.flows.map(flow => flow.id)).toEqual(['number-input']);
    expect(result.flows[0].steps[0].action).toMatch(/input\[type=number\]|number/i);
    expect(result.notes).toMatch(/Dropped 2 flows/);
    expect(result.notes).toMatch(/no checkbox/);
    expect(result.notes).toMatch(/no text input/);
  });
});

describe('inputs page crawl', () => {
  let fixture: InputsServer;
  const shots = mkdtempSync(join(tmpdir(), 'monkeytest-inputs-'));

  beforeAll(async () => {
    fixture = await startInputsServer();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it('fills the number input, generates no phantom flows, and is not inconclusive from a fill timeout', async () => {
    const llm: LLM = {
      providerLabel: 'stub',
      async generateJSON({ label }) {
        if (label === 'explorer.summarisePage') {
          return {
            summary: 'A page with a single number input.',
            authGated: false,
            interactive: [
              { kind: 'input', label: 'Number Input' },
              { kind: 'input', label: 'Text input' },
              { kind: 'input', label: 'Checkbox' },
            ],
          };
        }
        if (label === 'explorer.summariseSite') {
          return {
            siteType: 'demo',
            summary: 'A single inputs page used to exercise a number field.',
            publicJourneys: ['Type a number into the only field'],
          };
        }
        if (label === 'planner.generate') {
          return { flows: [numberFlow(fixture.url), textFlow(fixture.url), checkboxFlow(fixture.url)] };
        }
        if (label === 'runner.resolveAction') {
          return { tool: 'fill', locator: 'label', target: 'Number Input', value: '555-0100' };
        }
        throw new Error(`unexpected label ${label}`);
      },
    };

    const siteMap = await explore(fixture.url, llm, { maxPages: 1, headless: true });
    expect(siteMap.pages[0].inputs?.map(input => input.type)).toEqual(['number']);
    expect(siteMap.pages[0].inputs?.[0].preceding).toMatch(/Number/);

    const planned = await plan(siteMap, llm, { maxFlows: 4 });
    const described = planned.flows.map(flow => `${flow.name} ${flow.steps.map(step => step.action).join(' ')}`).join('\n');
    expect(described.toLowerCase()).not.toMatch(/checkbox/);
    expect(described.toLowerCase()).not.toMatch(/text input|text field|textbox/);
    expect(planned.flows.some(flow => /number/i.test(flow.name + flow.steps.map(step => step.action).join(' ')))).toBe(true);
    expect(planned.notes).toMatch(/Dropped/);

    const raw = await runPlan(planned, llm, {
      screenshotsDir: shots,
      headless: true,
      recordVideo: false,
      strictOracles: true,
      failOn5xx: true,
    });
    const run = triage(raw, { pagesVisited: siteMap.pages.length, failOn5xx: true });
    expect(run.outcome).not.toBe('inconclusive');
    const observations = run.flows.flatMap(flow => flow.steps.map(step => step.observation)).join('\n');
    expect(observations).not.toMatch(/Timeout \d+ms exceeded/);
    expect(observations).not.toMatch(/locator\.fill: Timeout/);
    expect(run.stats.flowsInconclusive ?? 0).toBe(0);
    expect(fixture.value()).toMatch(/^\d+$/);
    expect(fixture.value()).not.toContain('-');
    const filled = run.flows.flatMap(flow => flow.steps).find(step => step.tool === 'fill' && step.status === 'passed');
    expect(filled?.element?.bounding_box?.width).toBeGreaterThan(0);
  }, 45_000);

  it.skipIf(process.env.MONKEYTEST_LIVE_INPUTS !== '1')('fills the live herokuapp inputs page', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto('https://the-internet.herokuapp.com/inputs', { waitUntil: 'domcontentloaded' });
      const outcome = await executeAction(page, {
        tool: 'fill',
        locator: 'label',
        target: 'Number Input',
        value: '4',
      }, 15_000);
      expect(outcome.status).toBe('passed');
      expect(await page.locator('input[type=number]').inputValue()).toBe('4');
    } finally {
      await browser.close();
    }
  });
});

function inputsMap(): SiteMap {
  return {
    startUrl: 'http://127.0.0.1:9/inputs',
    siteType: 'demo',
    summary: 'Inputs.',
    pages: [{
      url: 'http://127.0.0.1:9/inputs',
      title: 'The Internet',
      summary: 'One number input.',
      interactive: [
        { kind: 'input', label: 'Number Input' },
        { kind: 'input', label: 'Text input' },
        { kind: 'input', label: 'Checkbox' },
      ],
      outboundLinks: [],
      authGated: false,
      inputs: [{ type: 'number', preceding: 'Number', heading: 'Inputs', ref: 'e1' }],
    }],
    pendingUrls: [],
    failedUrls: [],
  };
}

function numberFlow(url = 'http://127.0.0.1:9/inputs'): TestFlow {
  return {
    id: 'number-input',
    name: 'Number Input',
    description: 'Fill the Number Input.',
    kind: 'happy_path',
    startUrl: url,
    steps: [{ action: 'Fill the "Number Input" field', expectation: 'The number input accepts digits.' }],
    expectation: 'A number can be entered.',
    severityIfFails: 'major',
  };
}

function textFlow(url = 'http://127.0.0.1:9/inputs'): TestFlow {
  return {
    id: 'text-input',
    name: 'Text input',
    description: 'Fill the text input.',
    kind: 'happy_path',
    startUrl: url,
    steps: [{ action: 'Fill the "Text input" field', expectation: 'The text input accepts text.' }],
    expectation: 'Text can be entered.',
    severityIfFails: 'major',
  };
}

function checkboxFlow(url = 'http://127.0.0.1:9/inputs'): TestFlow {
  return {
    id: 'checkbox',
    name: 'Checkbox',
    description: 'Check the checkbox.',
    kind: 'happy_path',
    startUrl: url,
    steps: [{ action: 'Fill the "Checkbox" field', expectation: 'The checkbox toggles.' }],
    expectation: 'The checkbox can be checked.',
    severityIfFails: 'minor',
  };
}
