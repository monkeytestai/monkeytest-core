import { describe, expect, it } from 'vitest';
import { ActionSchema, resolveAction } from '../src/runner/actions.js';
import { fallbackSiteSummary, PageSummarySchema, SiteSummarySchema } from '../src/explorer/index.js';
import { coerceStringList } from '../src/llm/coerce.js';
import type { LLM } from '../src/llm/index.js';
import { salvageModelFlows } from '../src/planner/salvage.js';
import { PolishedBugSchema } from '../src/triager/index.js';
import type { SiteMapPage, TestFlow } from '../src/types.js';

describe('coerceStringList', () => {
  it('turns url/label objects, a bare string, and a nested array into strings', () => {
    expect(coerceStringList([
      { url: 'https://shop.example/login', label: 'Login' },
      { path: '/signup', name: 'Sign up' },
      'OTP wall',
      ['Forgot password', { href: '/reset', title: 'Reset' }],
      null,
      { foo: 1 },
      'OTP wall',
    ], { minLength: 2, maxItems: 6 })).toEqual([
      'Login (https://shop.example/login)',
      'Sign up (/signup)',
      'OTP wall',
      'Forgot password',
      'Reset (/reset)',
    ]);
  });

  it('keeps one sentence intact and wraps a single object', () => {
    expect(coerceStringList('Read pricing, then open Apply', { minLength: 3 })).toEqual([
      'Read pricing, then open Apply',
    ]);
    expect(coerceStringList({ url: '/login', label: 'Login' }, { minLength: 2 })).toEqual([
      'Login (/login)',
    ]);
  });

  it('omits an unreadable non-list and returns an empty array for an empty list', () => {
    expect(coerceStringList({ foo: 1 })).toBeUndefined();
    expect(coerceStringList([])).toEqual([]);
    expect(coerceStringList(null)).toBeUndefined();
  });
});

describe('structured output schemas', () => {
  it('accepts the site-summary shape that used to fail authSurfaces', () => {
    const parsed = SiteSummarySchema.parse({
      siteType: 'saas marketing site',
      summary: 'A business operations product with a public homepage and an account wall.',
      productName: { name: 'Northwind' },
      extra: true,
      publicJourneys: { name: 'Read the homepage, then open pricing' },
      authSurfaces: [
        { url: 'https://example.com/login', label: 'Login' },
        { url: 'https://example.com/signup', label: 'Sign up' },
      ],
    });
    expect(parsed.productName).toBe('Northwind');
    expect(parsed.publicJourneys).toEqual(['Read the homepage, then open pricing']);
    expect(parsed.authSurfaces).toEqual([
      'Login (https://example.com/login)',
      'Sign up (https://example.com/signup)',
    ]);
    expect('extra' in parsed).toBe(false);
  });

  it('unwraps a one-element array and a result envelope', () => {
    const parsed = SiteSummarySchema.parse({
      result: [{
        siteType: 'blog',
        summary: 'Essays about shipping software.',
        authSurfaces: [],
      }],
    });
    expect(parsed.siteType).toBe('blog');
    expect(parsed.summary).toContain('Essays');
    expect(parsed.authSurfaces).toEqual([]);
  });

  it('still rejects a site summary with no readable prose', () => {
    expect(SiteSummarySchema.safeParse({ siteType: true, summary: { nope: 1 } }).success).toBe(false);
  });

  it('coerces a per-page summary that models send as loose objects', () => {
    const parsed = PageSummarySchema.parse({
      summary: ['Corner shop homepage.', 'Checkout is linked.'],
      authGated: 'yes',
      interactive: {
        kind: 'Link',
        label: 'Checkout',
        selector: null,
      },
    });
    expect(parsed.summary).toBe('Corner shop homepage. Checkout is linked.');
    expect(parsed.authGated).toBe(true);
    expect(parsed.interactive).toEqual([{ kind: 'link', label: 'Checkout' }]);
  });

  it('drops an interactive entry whose kind is missing and keeps the summary', () => {
    const parsed = PageSummarySchema.parse({
      summary: 'A contact page.',
      authGated: 'maybe',
      interactive: ['Send', { label: 'Send message' }],
    });
    expect(parsed.authGated).toBe(false);
    expect(parsed.interactive).toEqual([]);
  });

  it('coerces a runner tool call that used action/selector and a numeric value', () => {
    expect(ActionSchema.parse({
      action: 'Click',
      selector: '#save-order',
      locator: 'CSS',
      value: 1,
    })).toEqual({
      tool: 'click',
      target: '#save-order',
      locator: 'css',
      value: '1',
    });
    expect(ActionSchema.parse({ tool: 'type', target: 'Email', value: 'qa@example.com' })).toMatchObject({
      tool: 'fill',
      target: 'Email',
      value: 'qa@example.com',
    });
  });

  it('clips an over-long polish field and reads text wrapped in an object', () => {
    const parsed = PolishedBugSchema.parse({
      title: { text: 'Checkout: pay button returns HTTP 500 from the API endpoint today' },
      observed: `${'The pay request failed. '.repeat(40)}`,
      expected: 'The pay button submits the order.',
      triage_notes: 'Inspect the payment handler for the 500 response.',
    });
    expect(parsed.title).toContain('Checkout:');
    expect(parsed.observed.length).toBeLessThanOrEqual(600);
    expect(parsed.observed.endsWith('…')).toBe(true);
    expect(parsed.triageNotes).toContain('payment handler');
  });
});

describe('fallbackSiteSummary', () => {
  it('builds journeys and auth lines from crawled pages only', () => {
    const pages: SiteMapPage[] = [
      {
        url: 'https://shop.example/',
        title: 'Shop',
        summary: 'Shop',
        interactive: [],
        outboundLinks: [],
        authGated: false,
      },
      {
        url: 'https://shop.example/login',
        title: 'Sign in',
        summary: 'Sign in',
        interactive: [],
        outboundLinks: [],
        authGated: true,
      },
    ];
    const summary = fallbackSiteSummary('https://shop.example/', pages);
    expect(summary.siteType).toBe('ecommerce');
    expect(summary.summary).toContain('shop.example');
    expect(summary.summary).toContain('Shop');
    expect(summary.publicJourneys).toEqual(['Visit Shop']);
    expect(summary.authSurfaces).toEqual(['Sign in (https://shop.example/login)']);
    expect(summary.summary).not.toMatch(/schema|Zod/i);
  });
});

describe('salvageModelFlows corner cases', () => {
  it('keeps one flow object whose only step arrived as an object', () => {
    const salvaged = salvageModelFlows({
      id: 'pricing',
      name: 'Read pricing',
      description: 'Open the pricing page from the homepage.',
      kind: 'Happy Path',
      startUrl: 'https://shop.example/pricing',
      steps: { instruction: 'Open the pricing page', expectation: 'Pricing content is visible.' },
      expectation: 'The pricing page loads.',
      severityIfFails: 'high',
    });
    expect(salvaged.dropped).toBe(0);
    expect(salvaged.flows).toHaveLength(1);
    expect(salvaged.flows[0]).toMatchObject({
      id: 'pricing',
      kind: 'happy_path',
      severityIfFails: 'major',
      steps: [{ action: 'Open the pricing page', expectation: 'Pricing content is visible.' }],
    });
  });
});

describe('resolveAction', () => {
  it('normalises a stub that returns selector/action instead of tool/target', async () => {
    const flow: TestFlow = {
      id: 'save',
      name: 'Save the order',
      description: 'Click save on checkout.',
      kind: 'happy_path',
      startUrl: 'https://shop.example/checkout',
      steps: [{ action: 'Click save' }],
      expectation: 'The order is saved.',
      severityIfFails: 'major',
    };
    const llm: LLM = {
      providerLabel: 'openai:gpt-4o-mini',
      async generateJSON() {
        return { action: 'tap', selector: 'button:Save order', rationale: 'The save button is visible.' };
      },
    };
    const action = await resolveAction(llm, flow, flow.steps[0], {
      url: flow.startUrl,
      title: 'Checkout',
      headings: [],
      buttons: ['Save order'],
      links: [],
      inputs: [],
    });
    expect(action).toMatchObject({
      tool: 'click',
      target: 'button:Save order',
      rationale: 'The save button is visible.',
    });
  });
});
