import { describe, expect, it } from 'vitest';
import type { LLM } from '../src/llm/index.js';
import { EventBus } from '../src/events.js';
import { plan } from '../src/planner/index.js';
import { salvageModelFlows } from '../src/planner/salvage.js';
import type { SiteMap, TestFlow } from '../src/types.js';

const ORIGIN = 'http://127.0.0.1:4173';
const HELP = 'https://www.bananabeings.com/help';
const HOME = 'https://www.bananabeings.com/';

function shop(id: string, startUrl = HOME): TestFlow {
  return {
    id,
    name: `Browse ${id}`,
    description: 'Open a product from the shop.',
    kind: 'happy_path',
    startUrl,
    steps: [{ action: 'Open a product', expectation: 'A product page loads.' }],
    expectation: 'A product page loads.',
    severityIfFails: 'major',
  };
}

function fixtureMap(): SiteMap {
  return {
    startUrl: `${ORIGIN}/`,
    siteType: 'ecommerce',
    summary: 'A corner shop.',
    pages: [
      {
        url: `${ORIGIN}/`,
        title: 'Shop',
        summary: 'Home.',
        interactive: [],
        outboundLinks: [`${ORIGIN}/checkout`, `${ORIGIN}/contact`],
        authGated: false,
        controls: [
          { kind: 'link', label: 'Checkout', href: `${ORIGIN}/checkout` },
          { kind: 'link', label: 'Contact', href: `${ORIGIN}/contact` },
        ],
      },
      {
        url: `${ORIGIN}/contact`,
        title: 'Contact',
        summary: 'Contact form.',
        interactive: [],
        outboundLinks: [`${ORIGIN}/`],
        authGated: false,
        forms: [{
          action: `${ORIGIN}/api/contact`,
          method: 'post',
          fields: ['email'],
          submitLabel: 'Send message',
        }],
        controls: [
          { kind: 'button', label: 'Send message' },
          { kind: 'link', label: 'Back home', href: `${ORIGIN}/` },
        ],
      },
      {
        url: `${ORIGIN}/checkout`,
        title: 'Checkout',
        summary: 'Checkout.',
        interactive: [],
        outboundLinks: [`${ORIGIN}/missing`],
        authGated: false,
        controls: [
          { kind: 'button', label: 'Save order' },
          { kind: 'link', label: 'Track shipment', href: `${ORIGIN}/missing` },
          { kind: 'button', label: 'Apply coupon', disabled: true },
        ],
      },
    ],
    pendingUrls: [`${ORIGIN}/missing`],
    failedUrls: [],
  };
}

function helpMap(): SiteMap {
  return {
    startUrl: HOME,
    siteType: 'ecommerce',
    summary: 'A demo shop.',
    pages: [
      {
        url: HOME,
        title: 'Banana Beings',
        summary: 'Shop homepage.',
        interactive: [],
        outboundLinks: [HELP],
        authGated: false,
      },
      {
        url: HELP,
        title: 'Help',
        summary: 'Contact form.',
        interactive: [],
        outboundLinks: [],
        authGated: false,
        forms: [{
          action: 'https://www.bananabeings.com/api/contact',
          method: 'post',
          fields: ['name', 'email', 'message'],
          submitLabel: 'Send message',
        }],
      },
    ],
    pendingUrls: [],
    failedUrls: [],
  };
}

describe('salvageModelFlows', () => {
  it('drops a flow with empty steps and keeps its siblings', () => {
    const flows = Array.from({ length: 5 }, (_, i) => shop(`browse-${i}`));
    const broken = { ...shop('browse-5'), steps: [] };
    const salvaged = salvageModelFlows([...flows, broken]);
    expect(salvaged.dropped).toBe(1);
    expect(salvaged.flows.map(flow => flow.id)).toEqual(flows.map(flow => flow.id));
  });
});

describe('plan survives a bad model response', () => {
  it('keeps the public form and fault controls when generateJSON throws a schema error', async () => {
    const events: string[] = [];
    const bus = new EventBus();
    bus.on(event => events.push(event.type));
    const llm: LLM = {
      providerLabel: 'stub',
      async generateJSON() {
        throw new Error(
          '[openai:gpt-4o-mini · planner.generate] response did not match schema: flows[5].steps: Array must contain at least 1 element(s)',
        );
      },
    };

    const result = await plan(fixtureMap(), llm, { maxFlows: 6, events: bus });
    const actions = result.flows.flatMap(flow => flow.steps.map(step => step.action)).join('\n');

    expect(result.flows.length).toBeGreaterThan(0);
    expect(result.flows.length).toBeLessThanOrEqual(6);
    expect(result.flows.some(flow => flow.id === 'public-form-submit')).toBe(true);
    expect(actions).toContain('Send message');
    expect(actions).toContain('Click "Save order"');
    expect(actions).toContain('Click "Track shipment"');
    expect(actions).toContain('Click "Apply coupon"');
    expect(result.notes).toContain('flows[5].steps');
    expect(result.notes).toContain('public form');
    expect(events).toContain('engine.error');
    expect(events).toContain('plan.complete');
  });

  it('keeps valid model flows when one sibling has empty steps, and still adds the form', async () => {
    const kept = Array.from({ length: 5 }, (_, i) => shop(`browse-${i}`, HOME));
    const llm: LLM = {
      providerLabel: 'stub',
      async generateJSON() {
        return {
          flows: [...kept, { ...shop('browse-5'), steps: [] }],
          notes: 'Sixth flow was blank.',
        };
      },
    };

    const result = await plan(helpMap(), llm, { maxFlows: 6 });
    expect(result.flows.some(flow => flow.id === 'public-form-submit')).toBe(true);
    expect(result.flows.some(flow => flow.id === 'browse-0')).toBe(true);
    expect(result.flows.some(flow => flow.id === 'browse-5')).toBe(false);
    expect(result.flows.length).toBeLessThanOrEqual(6);
    expect(result.notes).toContain('no usable steps');
    expect(result.notes).toContain('public form');
  });

  it('returns an empty plan when the model fails and the crawl has nothing to ground', async () => {
    const searchOnly: SiteMap = {
      startUrl: HOME,
      siteType: 'ecommerce',
      summary: 'Shop.',
      pages: [{
        url: HOME,
        title: 'Shop',
        summary: 'Home.',
        interactive: [],
        outboundLinks: [],
        authGated: false,
        forms: [{ action: `${HOME}search`, method: 'get', fields: ['q'], submitLabel: 'Search' }],
        controls: [{ kind: 'button', label: 'Search' }],
      }],
      pendingUrls: [],
      failedUrls: [],
    };
    const llm: LLM = {
      providerLabel: 'stub',
      async generateJSON() {
        throw new Error('response was not valid JSON');
      },
    };
    const result = await plan(searchOnly, llm, { maxFlows: 6 });
    expect(result.flows).toEqual([]);
    expect(result.notes).toContain('not valid JSON');
  });
});
