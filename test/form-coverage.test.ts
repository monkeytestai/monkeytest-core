import { describe, expect, it } from 'vitest';
import type { LLM } from '../src/llm/index.js';
import {
  formReserveCount,
  isFormSurfaceLink,
  planCrawlOrder,
  selectOutboundLinks,
} from '../src/explorer/queue.js';
import { plan } from '../src/planner/index.js';
import { ensurePublicFormFlow } from '../src/planner/forms.js';
import type { SiteMap, TestFlow } from '../src/types.js';

const HOME = 'https://www.bananabeings.com/';
const HELP = 'https://www.bananabeings.com/help';

describe('explorer form-surface reserve', () => {
  it('reserves a slot for /help when the homepage is a product grid', () => {
    const products = Array.from({ length: 30 }, (_, i) => ({
      url: `https://www.bananabeings.com/product/${i}`,
      text: 'Ripe Crew',
    }));
    const order = planCrawlOrder({
      startUrl: HOME,
      maxPages: 3,
      edges: {
        [HOME]: [
          ...products.slice(0, 12),
          { url: HELP, text: 'Help' },
          ...products.slice(12),
        ],
      },
    });
    expect(order).toEqual([
      HOME,
      HELP,
      'https://www.bananabeings.com/product/0',
    ]);
  });

  it('keeps a footer help link that sits past the ordinary link cap', () => {
    const links = [
      ...Array.from({ length: 100 }, (_, i) => ({
        url: `https://www.bananabeings.com/product/${i}`,
        text: 'Tee',
      })),
      { url: HELP, text: 'Contact' },
    ];
    const selected = selectOutboundLinks(links);
    expect(selected.some(link => link.url === HELP)).toBe(true);
    expect(selected.filter(link => link.url.includes('/product/'))).toHaveLength(80);
  });

  it('does not treat shop or auth URLs as form surfaces', () => {
    expect(formReserveCount(1)).toBe(0);
    expect(formReserveCount(3)).toBe(1);
    expect(formReserveCount(8)).toBe(2);
    expect(isFormSurfaceLink({ url: 'https://www.bananabeings.com/shop?g=men', text: 'Men' })).toBe(false);
    expect(isFormSurfaceLink({ url: HELP, text: 'Help' })).toBe(true);
    expect(isFormSurfaceLink({ url: 'https://www.bananabeings.com/pages/ask', text: 'Contact' })).toBe(true);
    expect(isFormSurfaceLink({ url: 'https://www.bananabeings.com/login', text: 'Help' })).toBe(false);
  });
});

describe('planner public form flow', () => {
  const siteMap: SiteMap = {
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
        forms: [{ action: `${HOME}search`, method: 'get', fields: ['q'], submitLabel: 'Search' }],
      },
      {
        url: HELP,
        title: 'Help',
        summary: 'Contact form.',
        interactive: [{ kind: 'form', label: 'Send message' }],
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

  const shop = flow('browse-tees', HOME, 'Open a product');

  it('injects a contact submit flow grounded in the crawled form', () => {
    const ensured = ensurePublicFormFlow([shop], siteMap, 2);
    expect(ensured.injected).toBe(true);
    expect(ensured.flows.map(item => item.id)).toEqual(['public-form-submit', 'browse-tees']);
    const formFlow = ensured.flows[0];
    expect(formFlow.startUrl).toBe(HELP);
    const text = formFlow.steps.map(step => step.action).join('\n');
    expect(text).toContain('name');
    expect(text).toContain('email');
    expect(text).toContain('message');
    expect(text).toContain('Send message');
    expect(text).toContain('/api/contact');
    expect(text).not.toContain('phone');
    expect(text).not.toContain('/search');
  });

  it('uses the only flow slot for the form when maxFlows is 1', () => {
    const ensured = ensurePublicFormFlow([shop], siteMap, 1);
    expect(ensured.flows).toHaveLength(1);
    expect(ensured.flows[0].startUrl).toBe(HELP);
  });

  it('does not add a second form flow when one already submits that page', () => {
    const existing = flow('ask-help', HELP, 'Fill email and submit the contact form');
    const ensured = ensurePublicFormFlow([existing, shop], siteMap, 2);
    expect(ensured.injected).toBe(false);
    expect(ensured.flows.map(item => item.id)).toEqual(['ask-help', 'browse-tees']);
  });

  it('does not let a header search box replace a shop flow', () => {
    const searchOnly: SiteMap = {
      ...siteMap,
      pages: siteMap.pages.filter(page => page.url === HOME),
    };
    const ensured = ensurePublicFormFlow([shop], searchOnly, 2);
    expect(ensured.injected).toBe(false);
    expect(ensured.flows.map(item => item.id)).toEqual(['browse-tees']);
  });

  it('asks the planner for the form even when the model only returns shop flows', async () => {
    const llm: LLM = {
      providerLabel: 'stub',
      async generateJSON() {
        return {
          flows: [{
            id: 'browse-tees',
            name: 'Browse tees',
            description: 'Look at a product.',
            kind: 'happy_path',
            startUrl: HOME,
            steps: [{ action: 'Open a product', expectation: 'A product page loads.' }],
            expectation: 'A product page loads.',
            severityIfFails: 'major',
          }],
          notes: 'Shop only.',
        };
      },
    };
    const result = await plan(siteMap, llm, { maxFlows: 2 });
    expect(result.flows.some(item => item.startUrl === HELP && item.id === 'public-form-submit')).toBe(true);
    expect(result.notes).toContain('public form');
  });
});

function flow(id: string, startUrl: string, action: string): TestFlow {
  return {
    id,
    name: id,
    description: action,
    kind: 'happy_path',
    startUrl,
    steps: [{ action }],
    expectation: action,
    severityIfFails: 'major',
  };
}
