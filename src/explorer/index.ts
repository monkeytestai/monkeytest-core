/**
 * Explorer phase
 *
 * Drives Playwright through the site, capturing the structural skeleton of
 * each page (title, headings, forms, buttons, links). The LLM is used per
 * page to:
 *   - write a one-sentence summary of what the page is for
 *   - call out the salient interactive elements
 *   - guess whether the page is auth-gated
 *
 * After all pages are visited (or the budget is exhausted) the LLM does one
 * final whole-site summary that names the site type ("ecommerce",
 * "saas dashboard", etc.).
 *
 * Link order is still breadth-first, but a few slots are reserved for
 * form / help / contact / support / about pages the crawl actually saw.
 * A shop homepage full of product links cannot spend the whole `maxPages`
 * budget before `/help` is visited. URLs that were never linked are not
 * invented.
 *
 * What the explorer is NOT:
 *   - It does not log in. Auth-gated flows are surfaced to the planner so
 *     they can be flagged as `auth_required` later.
 *   - It does not click destructive buttons. The visit is read-only.
 */

import { chromium, type Browser, type Page } from 'playwright';
import { basename } from 'node:path';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { LLM } from '../llm/index.js';
import type { SiteMap, SiteMapForm, SiteMapPage, SiteMapInteractive } from '../types.js';
import { type EventBus, noopBus } from '../events.js';
import {
  canonicalPageUrl,
  enqueueLinks,
  FORM_SURFACE_PATH_SOURCE,
  FORM_SURFACE_TEXT_SOURCE,
  isFormSurfaceLink,
  pickNextCrawlUrl,
  selectOutboundLinks,
  type CrawlQueueItem,
  type DiscoveredLink,
} from './queue.js';

export interface ExploreOptions {
  /** Hard cap on how many pages the explorer visits. Default 8. */
  maxPages?: number;
  /** Per-page navigation timeout in ms. Default 20_000. */
  pageTimeoutMs?: number;
  /** Whether to launch the browser headless. Default true. */
  headless?: boolean;
  /**
   * If set, the explorer takes a viewport-sized screenshot of every page
   * visited and writes it to this directory. The resulting absolute path is
   * stored on the SiteMapPage.screenshotPath field for downstream consumers
   * (the SaaS report page, the runner phase, the triager).
   */
  screenshotsDir?: string;
  /** Optional event hook (used by Monkey.run to stream events). */
  onPage?: (page: SiteMapPage) => void;
  /** Optional live event bus. Receives explorer lifecycle events. */
  events?: EventBus;
}

export async function explore(
  startUrl: string,
  llm: LLM,
  opts: ExploreOptions = {}
): Promise<SiteMap> {

  const maxPages    = opts.maxPages ?? 8;
  const timeout     = opts.pageTimeoutMs ?? 20_000;
  const headless    = opts.headless ?? true;
  const startOrigin = new URL(startUrl).origin;
  const events      = opts.events ?? noopBus();

  const visited = new Set<string>();
  const start = canonicalPageUrl(startUrl);
  const queue: CrawlQueueItem[] = [{ url: start, surface: isFormSurfaceLink({ url: start }) }];
  const pages: SiteMapPage[] = [];
  const failures: { url: string; reason: string }[] = [];
  let authUrlsQueued = 0;
  let surfaceVisited = 0;

  const screenshotsDir = opts.screenshotsDir ? resolve(opts.screenshotsDir) : null;
  if (screenshotsDir){
    mkdirSync(screenshotsDir, { recursive: true });
  }

  events.emit({
    phase: 'explorer', type: 'explore.start',
    message: `Crawling ${startUrl}…`,
    data: { startUrl, maxPages },
  });

  const browser: Browser = await chromium.launch({ headless });

  try {

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/537.36 '
        + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 monkeytest.ai',
      viewport: { width: 1280, height: 800 },
    });

    while (queue.length > 0 && pages.length < maxPages){

      const index = pickNextCrawlUrl(queue, {
        pagesVisited: pages.length,
        maxPages,
        surfaceVisited,
      });
      if (index < 0) break;
      const next = queue.splice(index, 1)[0];
      if (!next || visited.has(next.url)) continue;
      const url = next.url;
      visited.add(url);

      const page = await context.newPage();

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout });

        // SPAs (CRA, Next dev, Vite) often keep a websocket open for HMR so
        // networkidle never settles. We give it a brief shot, then fall back
        // to a `waitForFunction` that polls for actual rendered content.
        await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
        await page.waitForFunction(
          () => (document.body?.innerText || '').replace(/\s+/g, '').length > 30,
          undefined,
          { timeout: 8_000 },
        ).catch(() => {});

        const skeleton = await scrapePageSkeleton(page);

        // Screenshot each visited page if a directory was provided. Filename
        // is a deterministic, filesystem-safe hash of the URL so subsequent
        // runs can reference the same path.
        let screenshotPath: string | undefined;
        if (screenshotsDir){
          const filename = `page-${pages.length + 1}-${slugifyUrl(url)}.png`;
          const fullPath = join(screenshotsDir, filename);
          try {
            await page.screenshot({ path: fullPath, fullPage: false });
            screenshotPath = fullPath;
            events.emit({
              phase: 'explorer', type: 'explore.screenshot',
              message: `Captured screenshot of ${url}`,
              data: { url, screenshot: basename(fullPath) },
            });
          } catch (err) {
            // Don't fail the crawl just because a screenshot didn't save.
          }
        }

        // The LLM summarisation is best-effort. If it fails (404 model id,
        // 503, schema mismatch, …) we still want the page recorded with the
        // skeleton we already scraped — losing a screenshot + the entire page
        // because the LLM returned malformed JSON is overkill.
        let summary: { summary: string; interactive: SiteMapInteractive[]; authGated: boolean };
        try {
          summary = await summarisePageWithLLM(llm, url, skeleton);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          opts.onPage?.({
            url,
            title: skeleton.title,
            summary: `(LLM summary unavailable: ${reason.slice(0, 120)})`,
            interactive: [],
            outboundLinks: [],
            authGated: false,
          });
          summary = {
            summary: skeleton.title || `Page at ${url} (LLM summary unavailable)`,
            interactive: [],
            authGated: false,
          };
        }

        const forms = skeleton.forms.filter(form => form.action || form.fields.length > 0 || form.submitLabel);
        const outbound = selectOutboundLinks(
          skeleton.links
            .map(link => ({ url: canonicalPageUrl(link.url), text: link.text }))
            .filter(link => belongsToOrigin(link.url, startOrigin)),
        );

        const sm: SiteMapPage = {
          url,
          title: skeleton.title,
          summary: summary.summary,
          interactive: withScrapedForm(summary.interactive, forms),
          outboundLinks: outbound.map(link => link.url),
          ...(forms.length ? { forms } : {}),
          authGated: summary.authGated,
          ...(screenshotPath ? { screenshotPath } : {}),
        };

        pages.push(sm);
        if (isFormSurfaceLink({ url: sm.url, text: sm.title })) surfaceVisited += 1;
        opts.onPage?.(sm);
        events.emit({
          phase: 'explorer', type: 'explore.page_visited',
          message: `Explored ${url}`,
          data: {
            url,
            title: sm.title,
            summary: sm.summary,
            screenshot: screenshotPath ? basename(screenshotPath) : undefined,
            authGated: sm.authGated,
          },
        });

        // Auth walls eat crawl budget and produce login-only test plans.
        // Cap obvious auth URLs at one visit so the planner still knows a
        // login surface exists. Form/help links stay in the queue and are
        // pulled forward while the surface reserve is unfilled.
        if (!sm.authGated){
          authUrlsQueued = enqueueLinks(queue, visited, outbound, authUrlsQueued);
        }

      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        failures.push({ url, reason });
        events.emit({
          phase: 'explorer', type: 'explore.page_failed',
          message: `Failed to load ${url}`,
          data: { url, reason },
        });
      } finally {
        await page.close().catch(() => {});
      }

    }

    const overall = await summariseSiteWithLLM(llm, startUrl, pages);

    events.emit({
      phase: 'explorer', type: 'explore.complete',
      message: `Crawl complete: ${pages.length} page${pages.length === 1 ? '' : 's'} visited`
        + (failures.length ? `, ${failures.length} failed.` : '.'),
      data: {
        siteType: overall.siteType,
        pagesVisited: pages.length,
        pagesFailed: failures.length,
      },
    });

    return {
      startUrl,
      siteType: overall.siteType,
      summary: overall.summary,
      productName: overall.productName ?? undefined,
      publicJourneys: overall.publicJourneys ?? undefined,
      authSurfaces: overall.authSurfaces ?? undefined,
      pages,
      pendingUrls: queue.map(item => item.url),
      failedUrls: failures,
    };

  } finally {
    await browser.close().catch(() => {});
  }

}

/* ── Page skeleton scraping ───────────────────────────────────────────── */

interface PageSkeleton {
  url: string;
  title: string;
  headings: string[];
  visibleText: string;     // first ~1500 chars of body text
  links: DiscoveredLink[];
  forms: SiteMapForm[];
  buttons: string[];
}

async function scrapePageSkeleton(page: Page): Promise<PageSkeleton> {

  const url = page.url();
  const title = await page.title().catch(() => '');

  // Use page.evaluate for one cheap round-trip to collect everything we need.
  // Keep every form/help-style anchor, plus the first 80 ordinary ones, so a
  // long product grid cannot drop a footer "Help" link before it leaves the page.
  const collected = await page.evaluate(({ pathSource, textSource }) => {

    function txt(el: Element): string {
      return (el.textContent || '').trim().replace(/\s+/g, ' ');
    }

    const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
      .map(txt)
      .filter(Boolean)
      .slice(0, 20);

    const pathRe = new RegExp(pathSource, 'i');
    const textRe = new RegExp(textSource, 'i');
    const anchors = Array.from(document.querySelectorAll('a[href]'))
      .map(a => ({
        url: (a as HTMLAnchorElement).href,
        text: txt(a).slice(0, 80),
      }))
      .filter(link => link.url);
    const surfaceUrls = new Set<string>();
    const ordinaryUrls = new Set<string>();
    for (const link of anchors) {
      let path = link.url;
      try {
        const parsed = new URL(link.url);
        path = `${parsed.pathname}${parsed.search}`;
      } catch { /* keep the raw href */ }
      const surface = pathRe.test(path) || (link.text ? textRe.test(link.text) : false);
      if (surface) surfaceUrls.add(link.url);
      else if (ordinaryUrls.size < 80) ordinaryUrls.add(link.url);
    }
    const seen = new Set<string>();
    const links = anchors.filter(link => {
      if (seen.has(link.url)) return false;
      if (!surfaceUrls.has(link.url) && !ordinaryUrls.has(link.url)) return false;
      seen.add(link.url);
      return true;
    });

    const forms = Array.from(document.querySelectorAll('form')).slice(0, 10).map(f => {
      const form = f as HTMLFormElement;
      const inputs = Array.from(form.querySelectorAll('input, textarea, select'))
        .map(i => {
          const el = i as HTMLInputElement;
          const type = (el.type || '').toLowerCase();
          if (type === 'hidden' || type === 'submit' || type === 'button') return '';
          return el.name || el.placeholder || el.type || el.tagName.toLowerCase();
        })
        .filter(Boolean);
      const submit = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
      const submitLabel = submit ? (txt(submit) || (submit as HTMLInputElement).value || '') : '';
      return {
        action: form.action || '',
        method: (form.method || 'get').toLowerCase(),
        fields: inputs,
        ...(submitLabel ? { submitLabel: submitLabel.slice(0, 80) } : {}),
      };
    });

    const buttons = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'))
      .map(b => txt(b) || (b as HTMLInputElement).value || '')
      .filter(Boolean)
      .slice(0, 25);

    const visibleText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 2200);

    return { headings, links, forms, buttons, visibleText };

  }, {
    pathSource: FORM_SURFACE_PATH_SOURCE,
    textSource: FORM_SURFACE_TEXT_SOURCE,
  });

  return {
    url,
    title,
    headings: collected.headings,
    visibleText: collected.visibleText,
    links: collected.links,
    forms: collected.forms,
    buttons: collected.buttons,
  };

}

/* ── LLM: per-page summary ────────────────────────────────────────────── */

const PageSummarySchema = z.object({
  summary: z.string().min(3),
  authGated: z.boolean(),
  interactive: z.array(z.object({
    kind: z.enum(['form', 'button', 'link', 'input', 'menu']),
    label: z.string().min(1),
    selector: z.string().optional(),
  })).optional(),
});

async function summarisePageWithLLM(
  llm: LLM,
  url: string,
  skeleton: PageSkeleton
): Promise<{ summary: string; authGated: boolean; interactive: SiteMapInteractive[] }> {

  const prompt = `
You are a QA analyst inspecting a single web page during an exploratory crawl.
Based on the page metadata below, return JSON with three fields:

  - "summary": one sentence (max 30 words) naming the page's job for a visitor (e.g. "CRED marketing homepage promoting credit-card rewards").
  - "authGated": boolean — true if the page is a login/OTP wall, or clearly requires an existing session. A marketing page that merely links to Sign in is NOT auth-gated.
  - "interactive": up to 10 of the most important interactive elements a tester should care about (primary CTAs first). Each item has:
        kind     — one of "form" | "button" | "link" | "input" | "menu"
        label    — the human-readable label or visible text (max 60 chars)
        selector — optional CSS selector if you can confidently infer one (otherwise omit)

URL: ${url}
Title: ${skeleton.title}

Headings:
${skeleton.headings.map(h => `  - ${h}`).join('\n') || '  (none)'}

Buttons:
${skeleton.buttons.map(b => `  - ${b}`).join('\n') || '  (none)'}

Forms:
${skeleton.forms.map((f, i) => `  ${i + 1}. method=${f.method || 'get'} action=${f.action || '(none)'} submit=${f.submitLabel || '(none)'} fields=[${f.fields.join(', ')}]`).join('\n') || '  (none)'}

Visible text (excerpt):
${skeleton.visibleText || '(empty)'}

Reply with JSON only.
`;

  const parsed = await llm.generateJSON({
    label: 'explorer.summarisePage',
    prompt,
    schema: PageSummarySchema,
  });

  return {
    summary: parsed.summary,
    authGated: parsed.authGated,
    interactive: parsed.interactive ?? [],
  };

}

/* ── LLM: whole-site summary ──────────────────────────────────────────── */

const SiteSummarySchema = z.object({
  siteType: z.string().min(2),
  summary: z.string().min(3),
  productName: z.string().min(1).nullish(),
  publicJourneys: z.array(z.string().min(3)).max(6).nullish(),
  authSurfaces: z.array(z.string().min(2)).max(6).nullish(),
});

async function summariseSiteWithLLM(
  llm: LLM,
  startUrl: string,
  pages: SiteMapPage[]
): Promise<{ siteType: string; summary: string; productName?: string; publicJourneys?: string[]; authSurfaces?: string[] }> {

  if (pages.length === 0){
    return { siteType: 'unknown', summary: 'No pages were successfully visited.' };
  }

  const prompt = `
You just finished exploring a website as an anonymous visitor (you never logged in).
Understand the product, then describe it so a QA architect can design real user tests.

Return JSON:
  - "siteType": short category, e.g. "ecommerce", "fintech consumer app", "saas marketing site",
                "blog", "documentation", "marketplace", "internal tool", "other".
  - "productName": brand or product name if obvious, else omit.
  - "summary":  2–3 sentences (max 90 words): what the product does, who the visitor is,
                and which jobs they can complete WITHOUT an account.
  - "publicJourneys": up to 5 concrete anonymous journeys grounded in the pages below
                (e.g. "Read credit-card benefits and open Apply"). Do not invent pages.
  - "authSurfaces": login / signup / OTP walls you noticed. Empty array if none.

Start URL: ${startUrl}

Pages visited:
${pages.map(p => `  - ${p.url}\n      title: ${p.title}\n      auth-gated: ${p.authGated}\n      summary: ${p.summary}\n      interactive: ${p.interactive.map(i => i.label).join(', ') || '(none)'}`).join('\n')}

Reply with JSON only.
`;

  const parsed = await llm.generateJSON({
    label: 'explorer.summariseSite',
    prompt,
    schema: SiteSummarySchema,
  });

  return {
    siteType: parsed.siteType,
    summary: parsed.summary,
    productName: parsed.productName ?? undefined,
    publicJourneys: parsed.publicJourneys ?? undefined,
    authSurfaces: parsed.authSurfaces ?? undefined,
  };

}

/* ── Helpers ──────────────────────────────────────────────────────────── */

/**
 * Filesystem-safe filename slug derived from a URL. Caps length so we don't
 * blow past OS path limits on deep URLs.
 */
function slugifyUrl(u: string): string {
  try {
    const url = new URL(u);
    const raw = (url.hostname + url.pathname + url.search)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return raw.slice(0, 80) || 'page';
  } catch {
    return 'page';
  }
}

function belongsToOrigin(href: string, origin: string): boolean {
  try {
    const u = new URL(href);
    if (u.origin !== origin) return false;
    // Skip mailto:, tel:, file downloads, anchors, common asset types
    if (/\.(png|jpe?g|gif|svg|pdf|zip|ico|webp|avif|mp4|webm)(\?.*)?$/i.test(u.pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

function withScrapedForm(interactive: SiteMapInteractive[], forms: SiteMapForm[]): SiteMapInteractive[] {
  if (forms.length === 0 || interactive.some(item => item.kind === 'form')) return interactive;
  const form = [...forms].sort((a, b) => scrapedFormRank(b) - scrapedFormRank(a))[0];
  const label = (form.submitLabel || form.fields.slice(0, 3).join(', ') || 'form').slice(0, 60);
  return [...interactive, { kind: 'form', label }];
}

/** Header search boxes sort below a POST form so the planner sees the contact control. */
function scrapedFormRank(form: SiteMapForm): number {
  let score = 0;
  if ((form.method || 'get').toLowerCase() === 'post') score += 2;
  if (form.submitLabel) score += 1;
  if (/\/search(?:\/|$|\?)/i.test(form.action || '')) score -= 2;
  return score;
}
