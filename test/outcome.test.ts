import { describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import {
  alignVerdict,
  deriveRunOutcome,
  isOwnAutomationBug,
  matchesClientSoftExploratory,
  triage,
  valueForInput,
  verdictContradicts,
} from '../src/index.js';
import { directActionFromStep, executeAction, skeletonForLLM } from '../src/runner/actions.js';
import type { FlowResult, RunResult, StepResult } from '../src/types.js';

const CANNOT_TYPE = 'locator.fill: Error: Cannot type text into input[type=number]';
const NOT_AN_INPUT = 'locator.fill: Error: Element is not an <input>, <textarea> or [contenteditable] element';
const INVALID_SELECTOR = 'locator.click: Unexpected token "=" while parsing css selector';
const STRICT_MODE = 'strict mode violation: resolved to 2 elements';
const DETACHED = 'Element is not attached to the DOM';
const SELECTOR_TIMEOUT = 'Timeout 15000ms exceeded.\nwaiting for locator("input[name=phone]")';

describe('type-appropriate fill values', () => {
  it('never types 555-0100 into a number field', () => {
    expect(valueForInput({ type: 'number', label: 'Phone', name: 'phone' }, '555-0100')).toBe('5550100');
    expect(valueForInput({ type: 'number', label: 'Phone', name: 'phone' })).toBe('5550100');
    expect(valueForInput({ type: 'tel', label: 'Phone' }, '555-0100')).toBe('5550100');
    expect(valueForInput({ type: 'tel', name: 'tel' })).toMatch(/^\d+$/);
    expect(valueForInput({ type: 'email', label: 'Email' })).toBe('qa@example.com');
    expect(valueForInput({ type: 'url', label: 'Website' })).toBe('https://example.com');
    expect(valueForInput({ type: 'date', label: 'When' })).toBe('2026-01-15');
    expect(valueForInput({ type: 'number', label: 'Quantity' }, '555-0100')).toBe('5550100');
    expect(valueForInput({ type: 'number', label: 'Quantity' })).toBe('1');
  });

  it('fills a number input with digits when the action value is 555-0100', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent('<label>Phone <input type="number" name="phone" /></label>');
      const drafted = directActionFromStep('Fill the "Phone" field', await skeletonForLLM(page));
      expect(drafted?.value).toMatch(/^\d+$/);
      expect(drafted?.value).not.toContain('-');
      const outcome = await executeAction(page, {
        tool: 'fill',
        locator: 'label',
        target: 'Phone',
        value: '555-0100',
      }, 5_000);
      expect(outcome.status).toBe('passed');
      expect(outcome.error).toBeUndefined();
      expect(await page.locator('input[type=number]').inputValue()).toBe('5550100');
    } finally {
      await browser.close();
    }
  });
});

describe('our Playwright errors are inconclusive', () => {
  it.each([
    ['cannot type text', CANNOT_TYPE],
    ['not an input', NOT_AN_INPUT],
    ['invalid selector', INVALID_SELECTOR],
    ['strict mode', STRICT_MODE],
    ['detached', DETACHED],
    ['selector timeout', SELECTOR_TIMEOUT],
  ])('does not file a bug for %s', (_name, error) => {
    const run = triage(runWith(failedStep(error)));
    expect(run.bugs).toHaveLength(0);
    expect(run.flows[0].status).toBe('inconclusive');
    expect(run.outcome).toBe('inconclusive');
    expect(run.outcome_reason).toBe('automation_error');
    expect(run.outcome_detail).toMatch(/our test couldn't complete/i);
    expect(run.outcome_detail?.toLowerCase()).not.toMatch(/major bug/);
  });

  it('covers the mtaiclient confirmedBugs.js signatures, including critical Playwright rows', () => {
    const clientTimeout = {
      severity: 'major',
      title: 'Fill phone could not be completed',
      observed: 'waiting for locator("#phone") Timeout 15000ms exceeded',
      triage_notes: 'locator.fill timed out',
    };
    expect(matchesClientSoftExploratory(clientTimeout)).toBe(true);
    expect(isOwnAutomationBug(clientTimeout)).toBe(true);

    const pageTitle = {
      severity: 'major',
      title: 'Check if the page title is Welcome',
      observed: 'Expected to see the document title',
    };
    expect(matchesClientSoftExploratory(pageTitle)).toBe(true);
    expect(isOwnAutomationBug(pageTitle)).toBe(true);

    const criticalPlaywright = {
      severity: 'critical',
      title: 'Phone field',
      observed: CANNOT_TYPE,
    };
    expect(matchesClientSoftExploratory(criticalPlaywright)).toBe(false);
    expect(isOwnAutomationBug(criticalPlaywright)).toBe(true);

    expect(isOwnAutomationBug({
      severity: 'critical',
      title: 'Contact form',
      observed: 'POST /api/contact returned HTTP 500.',
      error: 'http-500',
    })).toBe(false);
  });

  it('still reports HTTP 5xx, page errors, and disabled controls', () => {
    const server = triage(runWith(failedStep('http-500', 'POST /api/contact returned HTTP 500.')));
    expect(server.bugs).toHaveLength(1);
    expect(server.bugs[0].fingerprintParts?.errorSignal).toBe('http-5xx');
    expect(server.outcome).toBe('bugs_found');
    expect(server.outcome_detail).toMatch(/Found 1 confirmed bug/);
    expect(server.outcome_detail?.toLowerCase()).not.toMatch(/worked smoothly/);

    const pageError = triage(runWith(failedStep('pageerror', 'Uncaught page error: boom is not defined')));
    expect(pageError.bugs).toHaveLength(1);
    expect(pageError.outcome).toBe('bugs_found');

    const disabled = triage(runWith(failedStep('element-disabled', 'Click on Save failed: control is disabled.')));
    expect(disabled.bugs).toHaveLength(1);
    expect(disabled.bugs[0].fingerprintParts?.errorSignal).toBe('element-disabled');
  });
});

describe('all-skipped flows and empty runs', () => {
  it('treats a flow whose every step was skipped as inconclusive, not passed', () => {
    const run = triage(passedFlow([
      step('skipped', 'Step intentionally skipped — not safe to automate.'),
      step('skipped', 'Step intentionally skipped — not safe to automate.', 2),
    ]));
    expect(run.bugs).toHaveLength(0);
    expect(run.flows[0].status).toBe('inconclusive');
    expect(run.flows[0].outcome_reason).toBe('all_flows_skipped');
    expect(run.flows[0].outcome_detail).toMatch(/our test couldn't complete/i);
    expect(run.outcome).toBe('inconclusive');
    expect(run.outcome_reason).toBe('all_flows_skipped');
    expect(run.stats.flowsPassed).toBe(0);
    expect(run.stats.flowsInconclusive).toBe(1);
  });

  it('uses login_required only when a login wall was actually seen', () => {
    const canned = triage({
      ...passedFlow([]),
      flows: [{
        ...passedFlow([]).flows[0],
        status: 'blocked',
        failureReason: 'Skipped: this journey needs an account. Login-path testing is available on Chimp and Gorilla plans.',
        steps: [step('blocked', 'Skipped: this journey needs an account. Login-path testing is available on Chimp and Gorilla plans.')],
      }],
    });
    expect(canned.flows[0].outcome_reason).not.toBe('login_required');
    expect(canned.flows[0].outcome_reason).toBe('not_attempted');
    expect(canned.outcome).toBe('inconclusive');

    const wall = triage(passedFlow([
      step('skipped', 'Landed on a login form with a password field. Please sign in to continue.'),
    ]));
    expect(wall.flows[0].outcome_reason).toBe('login_required');
    expect(wall.outcome_detail).toMatch(/login wall/i);
  });

  it('reports could_not_test when nothing was tested', () => {
    const empty = deriveRunOutcome({
      ...passedFlow([]),
      flows: [],
      stats: { ...passedFlow([]).stats, flowsTotal: 0 },
    }, { pagesVisited: 0 });
    expect(empty.outcome).toBe('could_not_test');
    expect(empty.outcome_reason).toBe('site_unreachable');
    expect(empty.outcome_detail).toMatch(/our test couldn't complete/i);

    const unreachable = triage(runWith(failedStep(
      'net::ERR_NAME_NOT_RESOLVED',
      'Could not load the starting page (net::ERR_NAME_NOT_RESOLVED).',
    )), { pagesVisited: 0 });
    expect(unreachable.bugs).toHaveLength(0);
    expect(unreachable.outcome).toBe('could_not_test');
    expect(unreachable.outcome_reason).toBe('site_unreachable');
  });
});

describe('verdict consistency', () => {
  it('rejects worked smoothly beside a bug, and major bug beside zero bugs', () => {
    const buggy = {
      bugCount: 1,
      outcome: 'bugs_found' as const,
      outcome_detail: 'Found 1 confirmed bug. Open the top one and confirm it on the site before treating this run as healthy.',
    };
    const contradiction = 'The site worked smoothly. This is a major bug, check right away.';
    expect(verdictContradicts(contradiction, buggy)).toBe(true);
    expect(alignVerdict(contradiction, buggy)).toBe(buggy.outcome_detail);
    expect(alignVerdict(contradiction, buggy).toLowerCase()).not.toMatch(/worked smoothly/);

    const clear = {
      bugCount: 0,
      outcome: 'inconclusive' as const,
      outcome_detail: 'Our test couldn\'t complete a journey because the runner hit its own browser error. This is not a bug in the site. Run again with the latest engine.',
    };
    expect(verdictContradicts('This is a major bug, check right away.', clear)).toBe(true);
    expect(alignVerdict('The site worked smoothly.', clear)).toBe(clear.outcome_detail);
    expect(alignVerdict(clear.outcome_detail, clear)).toBe(clear.outcome_detail);

    const clean = {
      bugCount: 0,
      outcome: 'clean' as const,
      outcome_detail: 'The journeys we completed worked smoothly, and there were no confirmed bugs. Run a broader pass if you want more pages and journeys covered.',
    };
    expect(verdictContradicts(clean.outcome_detail, clean)).toBe(false);
    expect(alignVerdict('Found a major bug.', clean).toLowerCase()).not.toMatch(/major bug/);
  });
});

function failedStep(error: string, observation = error): StepResult {
  return {
    index: 1,
    action: 'Fill the "Phone" field',
    expectation: 'The field accepts a value.',
    status: 'failed',
    observation,
    tool: 'fill',
    target: 'label:Phone',
    error,
  };
}

function step(status: StepResult['status'], observation: string, index = 1): StepResult {
  return {
    index,
    action: 'Fill the "Phone" field',
    status,
    observation,
  };
}

function runWith(recorded: StepResult): RunResult {
  return passedFlow([recorded], 'failed');
}

function passedFlow(steps: StepResult[], status: FlowResult['status'] = 'passed'): RunResult {
  const flow: FlowResult = {
    flowId: 'contact',
    name: 'Contact',
    description: 'Submit the contact form.',
    kind: 'happy_path',
    startUrl: 'https://shop.example/contact',
    status,
    steps,
    durationMs: 10,
    bugIds: [],
    trace: {
      version: 1,
      flowId: 'contact',
      name: 'Contact',
      startUrl: 'https://shop.example/contact',
      steps: steps.map(item => ({
        index: item.index,
        tool: 'fill',
        status: item.status,
        action: item.action,
        error: item.error,
        observation: item.observation,
        locator: { strategy: 'label', target: 'Phone', label: 'Phone' },
      })),
    },
  };
  return {
    startUrl: flow.startUrl,
    startedAt: '2026-10-30T00:00:00.000Z',
    finishedAt: '2026-10-30T00:00:01.000Z',
    flows: [flow],
    bugs: [],
    stats: {
      flowsTotal: 1,
      flowsPassed: status === 'passed' ? 1 : 0,
      flowsFailed: status === 'failed' ? 1 : 0,
      flowsBlocked: 0,
      stepsTotal: steps.length,
      stepsPassed: steps.filter(item => item.status === 'passed').length,
      stepsFailed: steps.filter(item => item.status === 'failed').length,
      bugsCritical: 0,
      bugsMajor: 0,
      bugsMinor: 0,
    },
  };
}
