import { describe, expect, it } from 'vitest';
import type { LLM } from '../src/llm/index.js';
import { applyDepthPreset, resolveDepthPreset } from '../src/depth.js';
import { plan } from '../src/planner/index.js';
import type { SiteMap, TestFlow } from '../src/types.js';

const ORIGIN = 'https://shop.example';

describe('Quick pass preset', () => {
  it('is basic: 6 pages, 4 flows, biased to forms, search, and primary CTAs', () => {
    const preset = resolveDepthPreset('basic');
    expect(preset).toMatchObject({
      id: 'basic',
      label: 'Quick pass',
      maxPages: 6,
      maxFlows: 4,
      focus: 'forms-search-cta',
    });
    expect(resolveDepthPreset('quick-pass').id).toBe('basic');
    expect(resolveDepthPreset('Quick pass').label).toBe('Quick pass');

    const capped = applyDepthPreset('basic', { maxPages: 8, maxFlows: 6, maxPagesSet: true, maxFlowsSet: false });
    expect(capped.maxPages).toBe(8);
    expect(capped.maxFlows).toBe(4);
    expect(capped.focus).toBe('forms-search-cta');
  });

  it('keeps a form, a search, and a primary CTA, and drops the disabled control', async () => {
    const llm: LLM = {
      providerLabel: 'stub',
      async generateJSON() {
        return { flows: [shopFlow()], notes: 'Shop only.' };
      },
    };
    const result = await plan(siteMap(), llm, { maxFlows: 4, focus: 'forms-search-cta' });
    const actions = result.flows.flatMap(flow => flow.steps.map(step => step.action)).join('\n');
    expect(result.flows.length).toBeGreaterThanOrEqual(3);
    expect(result.flows.length).toBeLessThanOrEqual(4);
    expect(actions).toContain('Send message');
    expect(actions.toLowerCase()).toContain('search');
    expect(actions).toContain('Get started');
    expect(actions).not.toContain('Apply coupon');
    expect(result.notes).toMatch(/Quick pass/);
  });
});

function shopFlow(): TestFlow {
  return {
    id: 'read-home',
    name: 'Read the homepage',
    description: 'Look at the shop.',
    kind: 'happy_path',
    startUrl: `${ORIGIN}/`,
    steps: [{ action: 'Read the introductory paragraph', expectation: 'The page loads.' }],
    expectation: 'The homepage loads.',
    severityIfFails: 'minor',
  };
}

function siteMap(): SiteMap {
  return {
    startUrl: `${ORIGIN}/`,
    siteType: 'ecommerce',
    summary: 'A shop with a contact form and a search box.',
    pages: [
      {
        url: `${ORIGIN}/`,
        title: 'Shop',
        summary: 'Home.',
        interactive: [],
        outboundLinks: [`${ORIGIN}/contact`],
        authGated: false,
        forms: [{ action: `${ORIGIN}/search`, method: 'get', fields: ['q'], submitLabel: 'Search' }],
        controls: [
          { kind: 'button', label: 'Get started' },
          { kind: 'button', label: 'Apply coupon', disabled: true },
        ],
      },
      {
        url: `${ORIGIN}/contact`,
        title: 'Contact',
        summary: 'Write to us.',
        interactive: [],
        outboundLinks: [],
        authGated: false,
        forms: [{
          action: `${ORIGIN}/api/contact`,
          method: 'post',
          fields: ['email', 'message'],
          inputs: [
            { label: 'Email', name: 'email', type: 'email' },
            { label: 'Message', name: 'message', type: 'textarea' },
          ],
          submitLabel: 'Send message',
        }],
        controls: [{ kind: 'button', label: 'Send message' }],
      },
    ],
    pendingUrls: [],
    failedUrls: [],
  };
}
