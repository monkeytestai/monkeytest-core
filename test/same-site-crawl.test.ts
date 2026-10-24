import { describe, expect, it } from 'vitest';
import type { LLM } from '../src/llm/index.js';
import {
  crawledPageUrl,
  isSameCrawlSite,
  planCrawlOrder,
} from '../src/explorer/queue.js';
import { plan } from '../src/planner/index.js';
import type { SiteMap, TestFlow } from '../src/types.js';

/**
 * Production shape from audit 0774b887-77d6-4255-83af-5cbe59c6cebb:
 * start at `http://bananabeings.com/`, the live site redirects to
 * `https://www.bananabeings.com`, and the homepage links Help and Track
 * order with that host. A strict `URL.origin` check drops every one of
 * those links, so the crawl never leaves home and the contact form on
 * `/help` is never planned.
 */

const START = 'http://bananabeings.com/';
const HOME_WWW = 'https://www.bananabeings.com/';
const HELP = 'https://www.bananabeings.com/help';
const HELP_HTTP = 'http://bananabeings.com/help';
const TRACK = 'https://www.bananabeings.com/track/missing';
const P0 = 'https://www.bananabeings.com/product/0';
const P1 = 'https://www.bananabeings.com/product/1';
const P2 = 'https://www.bananabeings.com/product/2';
const P3 = 'https://www.bananabeings.com/product/3';
const EVIL = 'https://evil.example/phish';
const SUBDOMAIN = 'https://shop.bananabeings.com/help';
const OTHER_PORT = 'https://www.bananabeings.com:8443/admin';

describe('crawl scope across www and http → https', () => {
  it('follows rewritten same-site links from an http apex start and stops at other hosts', () => {
    const order = planCrawlOrder({
      startUrl: START,
      maxPages: 6,
      edges: {
        [START]: [
          { url: EVIL, text: 'Deal' },
          { url: SUBDOMAIN, text: 'Help' },
          { url: OTHER_PORT, text: 'Admin' },
          { url: 'https://www.bananabeings.com/logo.png', text: 'Logo' },
          { url: 'mailto:hi@bananabeings.com', text: 'Email' },
          { url: P0, text: 'Ripe Crew' },
          { url: P1, text: 'Ripe Crew' },
          { url: P2, text: 'Ripe Crew' },
          { url: HELP, text: 'Help' },
          { url: HELP_HTTP, text: 'Help' },
          { url: TRACK, text: 'Track order' },
          { url: HOME_WWW, text: 'Home' },
          { url: P3, text: 'Ripe Crew' },
        ],
      },
    });

    expect(order.length).toBeGreaterThan(1);
    expect(order.length).toBeLessThanOrEqual(6);
    expect(order).toEqual([START, HELP, P0, P1, P2, TRACK]);
    expect(order).not.toContain(EVIL);
    expect(order).not.toContain(SUBDOMAIN);
    expect(order).not.toContain(OTHER_PORT);
    expect(order).not.toContain(HELP_HTTP);
    expect(order).not.toContain(HOME_WWW);
    expect(order).not.toContain('mailto:hi@bananabeings.com');
    expect(order).not.toContain('https://www.bananabeings.com/logo.png');
  });

  it('treats apex/www and http/https as one site, and keeps other ports distinct', () => {
    expect(isSameCrawlSite('HTTPS://WWW.BananaBeings.com/help', START)).toBe(true);
    expect(isSameCrawlSite(HELP, HOME_WWW)).toBe(true);
    expect(isSameCrawlSite(START, HOME_WWW)).toBe(true);
    expect(isSameCrawlSite(EVIL, START)).toBe(false);
    expect(isSameCrawlSite(SUBDOMAIN, START)).toBe(false);
    expect(isSameCrawlSite(OTHER_PORT, HOME_WWW)).toBe(false);
    expect(isSameCrawlSite('mailto:hi@bananabeings.com', START)).toBe(false);
    expect(isSameCrawlSite('https://www.bananabeings.com/logo.png', START)).toBe(false);

    expect(crawledPageUrl(START, HOME_WWW, START)).toBe(HOME_WWW);
    expect(crawledPageUrl(START, 'https://evil.example/away', START)).toBe(START);
    expect(crawledPageUrl(START, 'about:blank', START)).toBe(START);

    const local = 'http://127.0.0.1:4173/';
    const localOrder = planCrawlOrder({
      startUrl: local,
      maxPages: 4,
      edges: {
        [local]: [
          { url: 'http://127.0.0.1:4173/help', text: 'Help' },
          { url: 'http://127.0.0.1:4174/help', text: 'Help' },
          { url: 'https://127.0.0.1:4173/about', text: 'About' },
        ],
      },
    });
    expect(localOrder).toEqual([
      local,
      'http://127.0.0.1:4173/help',
      'https://127.0.0.1:4173/about',
    ]);
  });
});

describe('plan floor after an apex → www crawl', () => {
  const shop = flow('homepage-browse', START, 'Browse the homepage');
  const menu = flow('homepage-menu', START, 'Open the menu');

  const crawled: SiteMap = {
    startUrl: START,
    siteType: 'ecommerce',
    summary: 'A demo shop.',
    pages: [
      {
        url: START,
        title: 'Banana Beings',
        summary: 'Shop homepage.',
        interactive: [],
        outboundLinks: [HELP, TRACK],
        authGated: false,
        forms: [{
          action: 'https://www.bananabeings.com/search',
          method: 'get',
          fields: ['q'],
          submitLabel: 'Search',
        }],
        controls: [
          { kind: 'link', label: 'Help', href: HELP },
          { kind: 'link', label: 'Track order', href: TRACK },
          { kind: 'link', label: 'Ads', href: EVIL },
        ],
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
          inputs: [
            { name: 'name', label: 'Name', type: 'text' },
            { name: 'email', label: 'Email', type: 'email' },
            { name: 'message', label: 'Message', type: 'textarea' },
          ],
          submitLabel: 'Send message',
        }],
        controls: [{ kind: 'button', label: 'Send message' }],
      },
    ],
    pendingUrls: [],
    failedUrls: [],
  };

  it('keeps a grounded contact submit and the unvisited Track order link under maxFlows 2', async () => {
    const vague = flow('ask-help', HELP_HTTP, 'Submit the contact form');
    const llm: LLM = {
      providerLabel: 'stub',
      async generateJSON() {
        return { flows: [vague, shop, menu], notes: 'Homepage only.' };
      },
    };
    const result = await plan(crawled, llm, { maxFlows: 2 });
    expect(result.flows.map(item => item.id)).toEqual([
      'public-form-submit',
      'fault-link-track-order',
    ]);
    const formFlow = result.flows[0];
    expect(formFlow.startUrl).toBe(HELP);
    const text = formFlow.steps.map(step => step.action).join('\n');
    expect(text).toContain('email');
    expect(text).toContain('/api/contact');
    expect(text).toContain('Send message');
    expect(result.flows[1].steps[0].action).toBe('Click "Track order"');
    expect(result.flows[1].startUrl).toBe(START);
    const actions = result.flows.flatMap(item => item.steps.map(step => step.action)).join('\n');
    expect(actions).not.toContain('Ads');
    expect(actions).not.toContain('/search');
  });

  it('clicks Help from homepage controls when the form page was not crawled', async () => {
    const homeOnly: SiteMap = {
      ...crawled,
      pages: crawled.pages.filter(page => page.url === START),
    };
    const llm: LLM = {
      providerLabel: 'stub',
      async generateJSON() {
        return { flows: [shop, menu], notes: 'Homepage only.' };
      },
    };
    const result = await plan(homeOnly, llm, { maxFlows: 2 });
    // The form floor runs only for a public form the crawl recorded.
    // The homepage search box stays under the score cutoff. Help is a link click.
    expect(result.flows.some(item => item.id === 'public-form-submit')).toBe(false);
    expect(result.flows.map(item => item.id)).toEqual([
      'homepage-browse',
      'fault-link-help',
    ]);
    expect(result.flows[1].steps[0].action).toBe('Click "Help"');
  });
});

function flow(id: string, startUrl: string, action: string): TestFlow {
  return {
    id,
    name: id,
    description: action,
    kind: 'happy_path',
    startUrl,
    steps: [{ action, expectation: action }],
    expectation: action,
    severityIfFails: 'major',
  };
}
