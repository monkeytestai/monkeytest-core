import { describe, expect, it } from 'vitest';
import { triage } from '../src/triager/index.js';
import {
  failureCategory,
  fingerprintFailure,
  normaliseErrorSignal,
  normaliseLabel,
  normaliseLocation,
} from '../src/trace/fingerprint.js';
import type { FlowResult, RunResult, StepResult } from '../src/types.js';

const PLAYWRIGHT_NOT_EDITABLE = [
  'locator.fill: Error: Element is not an <input>, <textarea> or [contenteditable] element',
  'Call log:',
  '  - waiting for getByRole(\'textbox\', { name: /Email/i }).first()',
  '    - locator resolved to <div data-testid="email">not-an-input</div>',
].join('\n');

describe('normaliseErrorSignal', () => {
  it('collapses locator timeouts that differ only by duration, ids, and timestamps', () => {
    const a = normaliseErrorSignal(
      'Timeout 15000ms exceeded.\nwaiting for locator("#save") id=550e8400-e29b-41d4-a716-446655440000 at 2024-01-02T03:04:05.000Z',
    );
    const b = normaliseErrorSignal(
      'Timeout 30000ms exceeded.\nwaiting for locator("#save") id=11111111-2222-3333-4444-555555555555 at 2025-06-07T08:09:10.000Z',
    );
    expect(a).toBe('target-not-found');
    expect(b).toBe(a);
  });

  it('classifies a non-editable control before the generic locator-wait wording', () => {
    expect(normaliseErrorSignal(PLAYWRIGHT_NOT_EDITABLE)).toBe('not-editable');
  });

  it('strips volatile tokens from an otherwise unknown error', () => {
    expect(normaliseErrorSignal('boom order 918273 at 1710000000000 see https://example.com/x')).toBe(
      'boom order <n> at <ts> see <url>',
    );
  });

  it('does not keep the raw message when a known class matches', () => {
    expect(normaliseErrorSignal('net::ERR_CONNECTION_REFUSED at http://127.0.0.1:9/')).toBe('navigation-failed');
    expect(normaliseErrorSignal('invalid_url')).toBe('invalid-url');
    expect(normaliseErrorSignal('locator_mismatch')).toBe('locator-mismatch');
  });
});

describe('normaliseLocation', () => {
  it('templates ids and drops tracking query params', () => {
    const location = normaliseLocation(
      'https://Shop.Example/users/42/orders/7?b=2&utm_source=ad&a=paid&t=1710000000',
    );
    expect(location).toBe('https://shop.example/users/:id/orders/:id?a=paid&b=:id');
  });

  it('templates uuid path segments and ignores the hash', () => {
    const location = normaliseLocation(
      'https://shop.example/accounts/550e8400-e29b-41d4-a716-446655440000/home#paid',
    );
    expect(location).toBe('https://shop.example/accounts/:id/home');
  });
});

describe('normaliseLabel', () => {
  it('keeps short numbers and replaces ids', () => {
    expect(normaliseLabel('  Page  2 ')).toBe('page 2');
    expect(normaliseLabel('Order 18482931')).toBe('order <id>');
  });
});

describe('fingerprintFailure', () => {
  const shared = {
    error: PLAYWRIGHT_NOT_EDITABLE,
    location: 'http://127.0.0.1:4321/checkout/99?cachebust=1',
    locator: {
      strategy: 'role' as const,
      target: 'textbox:Email',
      role: 'textbox',
      name: 'Email',
    },
  };

  it('ignores the LLM tool choice', () => {
    const click = fingerprintFailure({ ...shared, tool: 'click' });
    const fill = fingerprintFailure({ ...shared, tool: 'fill' });
    expect(fill.fingerprint).toBe(click.fingerprint);
    expect(fill.parts).toEqual(click.parts);
    expect(fill.parts).not.toHaveProperty('tool');
    expect(JSON.stringify(fill.parts)).not.toContain('fill');
    expect(JSON.stringify(fill.parts)).not.toContain('click');
  });

  it('changes when the element role or the error class changes', () => {
    const base = fingerprintFailure({ ...shared, tool: 'fill' });
    const otherRole = fingerprintFailure({
      ...shared,
      tool: 'fill',
      locator: { ...shared.locator, role: 'button', name: 'Email' },
    });
    const otherSignal = fingerprintFailure({
      ...shared,
      tool: 'fill',
      error: 'Timeout 5000ms exceeded waiting for locator("#email")',
    });
    expect(otherRole.fingerprint).not.toBe(base.fingerprint);
    expect(otherSignal.fingerprint).not.toBe(base.fingerprint);
    expect(otherSignal.parts.errorSignal).toBe('target-not-found');
  });

  it('uses the failure category as the oracle, not the tool name', () => {
    expect(failureCategory({ tool: 'goto', error: 'net::ERR_CONNECTION_REFUSED' })).toBe('navigation');
    expect(failureCategory({ tool: 'fill', error: PLAYWRIGHT_NOT_EDITABLE })).toBe('interaction');
    expect(failureCategory({ tool: 'assert_text', error: 'missing' })).toBe('assertion');
    const nav = fingerprintFailure({
      tool: 'goto',
      error: 'net::ERR_NAME_NOT_RESOLVED',
      location: 'https://shop.example/start',
    });
    expect(nav.parts.category).toBe('navigation');
    expect(nav.parts.role).toBe('');
    expect(nav.parts.name).toBe('');
  });

  it('treats the same page key as the same bug when only the id changes', () => {
    const a = fingerprintFailure({ ...shared, tool: 'fill', location: 'https://shop.example/users/1' });
    const b = fingerprintFailure({ ...shared, tool: 'fill', location: 'https://shop.example/users/2' });
    expect(a.parts.location).toBe('https://shop.example/users/:id');
    expect(b.fingerprint).toBe(a.fingerprint);
  });
});

describe('triage fingerprints', () => {
  it('stores v2 parts and the trace prefix, and matches a different tool on the same element', () => {
    const click = triage(runWith([failedStep('click', 'Timeout 15000ms exceeded waiting for locator("#save")')]));
    const fill = triage(runWith([failedStep('fill', 'Timeout 10ms exceeded waiting for locator("#save") id 99999')]));
    expect(click.bugs).toHaveLength(1);
    expect(fill.bugs[0].fingerprint).toBe(click.bugs[0].fingerprint);
    expect(click.bugs[0].fingerprintParts).toMatchObject({
      version: 2,
      category: 'interaction',
      role: 'button',
      name: 'save',
      errorSignal: 'target-not-found',
      location: 'https://shop.example/checkout',
    });
    expect(click.bugs[0].trace?.steps.map(step => step.index)).toEqual([0, 1, 2]);
    expect(click.bugs[0].trace?.steps.some(step => step.tool === 'click')).toBe(true);
    expect(click.bugs[0].evidence.screenshots).toEqual(['/tmp/shot.png']);
  });
});

function failedStep(tool: string, error: string): StepResult {
  return {
    index: 2,
    action: 'Press save',
    expectation: 'The form submits',
    status: 'failed',
    observation: error,
    tool,
    target: 'button:Save',
    error,
    screenshotPath: '/tmp/shot.png',
  };
}

function runWith(steps: StepResult[]): RunResult {
  const flow: FlowResult = {
    flowId: 'checkout',
    name: 'Checkout',
    description: 'Pay',
    kind: 'happy_path',
    startUrl: 'https://shop.example/checkout',
    status: 'failed',
    steps: [
      { index: 1, action: 'Open cart', status: 'passed', observation: 'Opened.' },
      ...steps,
      { index: 3, action: 'Confirm', status: 'blocked', observation: 'Earlier step failed; not attempted.' },
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
          index: 1,
          tool: 'click',
          status: 'passed',
          action: 'Open cart',
          locator: { strategy: 'role', target: 'link:Cart', role: 'link', name: 'Cart' },
          urlBefore: 'https://shop.example/checkout',
        },
        {
          index: 2,
          tool: steps[0].tool as 'click',
          status: 'failed',
          action: 'Press save',
          error: steps[0].error,
          locator: { strategy: 'role', target: 'button:Save', role: 'button', name: 'Save' },
          urlBefore: 'https://shop.example/checkout',
          screenshotPath: '/tmp/shot.png',
        },
      ],
    },
  };
  return {
    startUrl: flow.startUrl,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    flows: [flow],
    bugs: [],
    stats: {
      flowsTotal: 1, flowsPassed: 0, flowsFailed: 1, flowsBlocked: 0,
      stepsTotal: 3, stepsPassed: 1, stepsFailed: 1,
      bugsCritical: 0, bugsMajor: 0, bugsMinor: 0,
    },
  };
}
