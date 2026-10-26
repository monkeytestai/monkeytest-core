/**
 * Whole-site summarisation used to throw out of `explore` when the model
 * returned auth surfaces as `{url, label}` objects. The crawl had already
 * finished. These tests drive `explore` with a stub model and a local page.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { explore } from '../src/explorer/index.js';
import { EventBus } from '../src/events.js';
import type { LLM } from '../src/llm/index.js';
import { plan } from '../src/planner/index.js';
import { startDemoServer, type DemoServer } from './fixtures/demo-app/server.ts';

const SITE_WARNING = 'Site summary from the model was incomplete; continuing with a basic map of the site.';

describe('explore survives a bad site summary', () => {
  let demo: DemoServer;

  beforeAll(async () => {
    demo = await startDemoServer();
  });

  afterAll(async () => {
    await demo.close();
  });

  it('stores object-shaped authSurfaces as strings and continues', async () => {
    const events: { type: string; message: string }[] = [];
    const bus = new EventBus();
    bus.on(event => events.push({ type: event.type, message: event.message }));

    const llm: LLM = {
      providerLabel: 'openai:gpt-4o-mini',
      async generateJSON({ label }) {
        if (label === 'explorer.summarisePage') {
          return {
            summary: 'Corner shop homepage with a checkout link.',
            authGated: 'false',
            interactive: { kind: 'Link', label: 'Checkout', selector: null },
          };
        }
        if (label === 'explorer.summariseSite') {
          return {
            siteType: 'ecommerce',
            summary: 'A corner shop where a visitor can read the homepage and open checkout.',
            productName: 'Corner shop',
            publicJourneys: 'Open checkout from the homepage',
            authSurfaces: [
              { url: `${demo.url}/login`, label: 'Login' },
              { url: `${demo.url}/signup`, label: 'Sign up' },
            ],
          };
        }
        throw new Error(`unexpected label ${label}`);
      },
    };

    const siteMap = await explore(demo.url, llm, { maxPages: 1, events: bus });
    const planned = await plan(siteMap, {
      providerLabel: 'stub',
      async generateJSON() {
        return { flows: [], notes: 'No model flows.' };
      },
    }, { maxFlows: 2 });

    expect(siteMap.pages.length).toBe(1);
    expect(siteMap.pages[0].interactive).toEqual([{ kind: 'link', label: 'Checkout' }]);
    expect(siteMap.pages[0].authGated).toBe(false);
    expect(siteMap.authSurfaces).toEqual([
      `Login (${demo.url}/login)`,
      `Sign up (${demo.url}/signup)`,
    ]);
    expect(siteMap.publicJourneys).toEqual(['Open checkout from the homepage']);
    expect(siteMap.warnings).toBeUndefined();
    expect(events.map(event => event.type)).toContain('explore.complete');
    expect(events.some(event => event.type === 'explore.warning')).toBe(false);
    expect(planned.flows.length).toBeGreaterThan(0);
  });

  it('keeps the crawl when summariseSite throws a schema error and emits a user-facing warning', async () => {
    const events: { type: string; message: string; detail?: unknown }[] = [];
    const bus = new EventBus();
    bus.on(event => events.push({
      type: event.type,
      message: event.message,
      detail: event.data?.detail,
    }));

    const llm: LLM = {
      providerLabel: 'openai:gpt-4o-mini',
      async generateJSON({ label }) {
        if (label === 'explorer.summarisePage') {
          return {
            summary: 'Corner shop homepage with a checkout link.',
            authGated: false,
            interactive: [],
          };
        }
        if (label === 'explorer.summariseSite') {
          throw new Error(
            '[openai:gpt-4o-mini · explorer.summariseSite] response did not match schema: authSurfaces: Expected string, received object',
          );
        }
        throw new Error(`unexpected label ${label}`);
      },
    };

    const siteMap = await explore(demo.url, llm, { maxPages: 1, events: bus });
    const warning = events.find(event => event.type === 'explore.warning');

    expect(siteMap.pages.length).toBe(1);
    expect(siteMap.siteType).toBe('ecommerce');
    expect(siteMap.summary).toContain('Corner shop homepage');
    expect(siteMap.summary).not.toMatch(/did not match schema|Zod/i);
    expect(siteMap.warnings).toEqual([SITE_WARNING]);
    expect(warning?.message).toBe(SITE_WARNING);
    expect(warning?.message).not.toMatch(/schema|Zod|authSurfaces/i);
    expect(String(warning?.detail)).toContain('response did not match schema');
    expect(events.map(event => event.type)).toContain('explore.complete');
  });

  it('records a page when per-page JSON is unreadable and still summarises the site', async () => {
    const events: { type: string; message: string }[] = [];
    const bus = new EventBus();
    bus.on(event => events.push({ type: event.type, message: event.message }));

    const llm: LLM = {
      providerLabel: 'openai:gpt-4o-mini',
      async generateJSON({ label }) {
        if (label === 'explorer.summarisePage') {
          throw new Error('[openai:gpt-4o-mini · explorer.summarisePage] response was not valid JSON');
        }
        if (label === 'explorer.summariseSite') {
          return {
            siteType: 'ecommerce',
            summary: 'A corner shop.',
            authSurfaces: [],
          };
        }
        throw new Error(`unexpected label ${label}`);
      },
    };

    const siteMap = await explore(demo.url, llm, { maxPages: 1, events: bus });
    expect(siteMap.pages).toHaveLength(1);
    expect(siteMap.pages[0].title).toBe('Shop');
    expect(siteMap.pages[0].summary).toBe('Shop');
    expect(siteMap.pages[0].summary).not.toMatch(/not valid JSON|schema/i);
    expect(siteMap.summary).toBe('A corner shop.');
    expect(siteMap.warnings?.[0]).toContain(demo.url);
    expect(siteMap.warnings?.[0]).toContain('Page summary from the model was incomplete');
    expect(events.some(event => event.message.includes('not valid JSON'))).toBe(false);
  });
});
