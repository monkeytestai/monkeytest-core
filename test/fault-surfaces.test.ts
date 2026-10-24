import { describe, expect, it } from 'vitest';
import type { LLM } from '../src/llm/index.js';
import { directActionFromStep, groundFillAction, type PageSkeletonForLLM } from '../src/runner/actions.js';
import { plan } from '../src/planner/index.js';
import { ensurePublicFormFlow } from '../src/planner/forms.js';
import { ensureFaultSurfaceFlows } from '../src/planner/faults.js';
import type { SiteMap, TestFlow } from '../src/types.js';

const ORIGIN = 'http://127.0.0.1:4173';

function shopFlow(): TestFlow {
  return {
    id: 'read-home',
    name: 'Read the homepage',
    description: 'Read the shop homepage copy.',
    kind: 'happy_path',
    startUrl: `${ORIGIN}/`,
    steps: [{ action: 'Read the introductory paragraph on the page' }],
    expectation: 'The homepage is readable.',
    severityIfFails: 'minor',
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
        outboundLinks: [`${ORIGIN}/missing`, `${ORIGIN}/`, `${ORIGIN}/contact`],
        authGated: false,
        controls: [
          { kind: 'button', label: 'Save order' },
          { kind: 'link', label: 'Track shipment', href: `${ORIGIN}/missing` },
          { kind: 'button', label: 'Apply coupon', disabled: true },
          { kind: 'link', label: 'Back home', href: `${ORIGIN}/` },
          { kind: 'link', label: 'Contact', href: `${ORIGIN}/contact` },
        ],
      },
    ],
    pendingUrls: [`${ORIGIN}/missing`],
    failedUrls: [],
  };
}

describe('fault-surface flows', () => {
  it('keeps a form, an enabled button, an unvisited link, and a disabled control under maxFlows 4', () => {
    const siteMap = fixtureMap();
    const withForm = ensurePublicFormFlow([shopFlow()], siteMap, 4);
    const faults = ensureFaultSurfaceFlows(withForm.flows, siteMap, 4);
    const actions = faults.flows.flatMap(flow => flow.steps.map(step => step.action)).join('\n');
    expect(faults.added).toEqual(['Save order', 'Track shipment', 'Apply coupon']);
    expect(actions).toContain('Send message');
    expect(actions).toContain('Click "Save order"');
    expect(actions).toContain('Click "Track shipment"');
    expect(actions).toContain('Click "Apply coupon"');
    expect(actions).not.toContain('Read the introductory');
    expect(actions).not.toContain('Back home');
    expect(faults.flows).toHaveLength(4);
    expect(faults.flows[0].id).toBe('public-form-submit');
  });

  it('uses the second slot for the enabled button when maxFlows is 2', () => {
    const siteMap = fixtureMap();
    const withForm = ensurePublicFormFlow([shopFlow()], siteMap, 2);
    const faults = ensureFaultSurfaceFlows(withForm.flows, siteMap, 2);
    expect(faults.flows.map(flow => flow.id)).toEqual([
      'public-form-submit',
      'fault-button-save-order',
    ]);
  });

  it('does not invent a fault flow from a search submit', () => {
    const siteMap: SiteMap = {
      ...fixtureMap(),
      pages: [{
        url: `${ORIGIN}/`,
        title: 'Shop',
        summary: 'Home.',
        interactive: [],
        outboundLinks: [],
        authGated: false,
        forms: [{ action: `${ORIGIN}/search`, method: 'get', fields: ['q'], submitLabel: 'Search' }],
        controls: [{ kind: 'button', label: 'Search' }],
      }],
    };
    const ensured = ensureFaultSurfaceFlows([shopFlow()], siteMap, 4);
    expect(ensured.added).toEqual([]);
    expect(ensured.flows.map(flow => flow.id)).toEqual(['read-home']);
  });

  it('asks plan() for those controls even when the model only returns a homepage flow', async () => {
    const llm: LLM = {
      providerLabel: 'stub',
      async generateJSON() {
        return {
          flows: [shopFlow()],
          notes: 'Homepage only.',
        };
      },
    };
    const result = await plan(fixtureMap(), llm, { maxFlows: 4 });
    const actions = result.flows.flatMap(flow => flow.steps.map(step => step.action)).join('\n');
    expect(actions).toContain('Send message');
    expect(actions).toContain('Click "Save order"');
    expect(actions).toContain('Click "Track shipment"');
    expect(actions).toContain('Click "Apply coupon"');
    expect(result.notes).toContain('Save order');
  });

  it('keeps the contact action when a valid plan is shop flows plus a vague submit', async () => {
    const shops = [
      'homepage-quick-add-ripe-top',
      'men-shop-add-multiple-tops',
      'men-crew-neck-filter-and-add',
      'about-page-brand-information',
      'browse-womens-apparel',
    ].map(id => ({
      ...shopFlow(),
      id,
      name: `Shop ${id}`.slice(0, 80),
      description: 'Add a product from the shop.',
      startUrl: id.startsWith('about') ? `${ORIGIN}/about` : `${ORIGIN}/`,
      steps: [{ action: 'Add a ripe top to the bag', expectation: 'The bag updates.' }],
    }));
    const weak = {
      ...shopFlow(),
      id: 'help-page-send-note',
      name: 'Send a note',
      description: 'Submit whatever is on the contact page.',
      startUrl: `${ORIGIN}/contact`,
      steps: [{ action: 'Submit the page', expectation: 'Something happens.' }],
      expectation: 'The page submits.',
    };
    const llm: LLM = {
      providerLabel: 'stub',
      async generateJSON() {
        return { flows: [weak, ...shops], notes: 'Shop flows plus a vague submit.' };
      },
    };
    const result = await plan(fixtureMap(), llm, { maxFlows: 6 });
    const form = result.flows.find(flow => flow.id === 'public-form-submit');
    expect(form?.startUrl).toBe(`${ORIGIN}/contact`);
    expect(form?.steps.map(step => step.action).join('\n')).toContain('/api/contact');
    expect(result.flows.some(flow => flow.id === 'help-page-send-note')).toBe(false);
    expect(result.flows.some(flow => flow.id.startsWith('fault-'))).toBe(true);
    expect(result.flows.length).toBeLessThanOrEqual(6);
  });
});

describe('direct actions', () => {
  const skeleton: PageSkeletonForLLM = {
    url: `${ORIGIN}/checkout`,
    title: 'Checkout',
    headings: ['Checkout'],
    buttons: ['Save order', 'Apply coupon', 'Send message'],
    links: [{ text: 'Track shipment', href: `${ORIGIN}/missing` }],
    inputs: [{ label: 'Email', name: 'email', type: 'email' }],
  };

  it('clicks and fills a quoted label without a model', () => {
    expect(directActionFromStep('Click "Save order"', skeleton)).toMatchObject({
      tool: 'click', locator: 'role', target: 'button:Save order',
    });
    expect(directActionFromStep('Click "Track shipment"', skeleton)).toMatchObject({
      tool: 'click', locator: 'role', target: 'link:Track shipment',
    });
    expect(directActionFromStep('Click Save order', skeleton)).toMatchObject({
      target: 'button:Save order',
    });
    expect(directActionFromStep('Fill the "email" field on the form that submits to /api/contact', skeleton)).toMatchObject({
      tool: 'fill', locator: 'label', target: 'Email', value: 'qa@example.com',
    });
    expect(directActionFromStep('Fill the "email" field on the form that submits to /api/contact', {
      ...skeleton,
      inputs: [{ name: 'email', type: 'email' }],
    })).toMatchObject({
      tool: 'fill', locator: 'css', target: '[name="email"]', value: 'qa@example.com',
    });
    expect(directActionFromStep('Fill the "What do you need?" field (name="message") on the form that submits to /api/contact', {
      ...skeleton,
      inputs: [{ label: 'What do you need?', name: 'message', type: 'textarea' }],
    })).toMatchObject({
      tool: 'fill', locator: 'label', target: 'What do you need?', value: 'Hello from monkeytest',
    });
    expect(groundFillAction({
      tool: 'fill', locator: 'placeholder', target: 'Email', value: 'qa@example.com',
    }, skeleton)).toMatchObject({
      tool: 'fill', locator: 'label', target: 'Email', value: 'qa@example.com',
    });
    expect(groundFillAction({
      tool: 'fill', locator: 'placeholder', target: 'Email',
    }, {
      ...skeleton,
      inputs: [{ name: 'email', type: 'email' }],
    })).toMatchObject({
      locator: 'css', target: '[name="email"]', value: 'qa@example.com',
    });
    expect(groundFillAction({
      tool: 'fill', locator: 'placeholder', target: 'Search', value: 'tee',
    }, {
      ...skeleton,
      inputs: [{ placeholder: 'Search', type: 'search' }],
    })).toMatchObject({
      locator: 'placeholder', target: 'Search', value: 'tee',
    });
    expect(directActionFromStep('Submit the form that submits to /api/contact by clicking "Send message"', skeleton)).toMatchObject({
      tool: 'click', target: 'button:Send message',
    });
  });

  it('leaves a vague step for the model', () => {
    expect(directActionFromStep('Read the introductory paragraph on the page', skeleton)).toBeNull();
    expect(directActionFromStep('Click "Missing control"', skeleton)).toBeNull();
  });
});
