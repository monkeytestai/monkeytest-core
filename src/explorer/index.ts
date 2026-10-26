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
 * Crawl scope is the site, not a single `URL.origin`. `http://shop.example/`
 * and `https://www.shop.example/help` are the same site. Another host,
 * another subdomain, or another explicit port is not. A redirect that stays
 * on the site is recorded as the URL the browser landed on.
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
import {
  clipText,
  coerceBoolean,
  coerceEnum,
  coerceProse,
  coerceStringList,
  coerceToString,
  logModelDetail,
  unwrapModelObject,
} from '../llm/coerce.js';
import type { SiteMap, SiteMapControl, SiteMapForm, SiteMapPage, SiteMapInteractive } from '../types.js';
import { type EventBus, noopBus } from '../events.js';
import {
  canonicalPageUrl,
  crawledPageUrl,
  enqueueLinks,
  FORM_SURFACE_PATH_SOURCE,
  FORM_SURFACE_TEXT_SOURCE,
  isFormSurfaceLink,
  linksOnCrawlSite,
  looksLikeAuthUrl,
  pickNextCrawlUrl,
  rememberVisited,
  selectOutboundLinks,
  wasVisited,
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
  const events      = opts.events ?? noopBus();

  const visited = new Set<string>();
  const start = canonicalPageUrl(startUrl);
  const queue: CrawlQueueItem[] = [{ url: start, surface: isFormSurfaceLink({ url: start }) }];
  const pages: SiteMapPage[] = [];
  const failures: { url: string; reason: string }[] = [];
  const warnings: string[] = [];
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
      if (!next || wasVisited(visited, next.url)) continue;
      const requestedUrl = next.url;
      rememberVisited(visited, requestedUrl);

      const page = await context.newPage();

      try {
        await page.goto(requestedUrl, { waitUntil: 'domcontentloaded', timeout });
        const url = crawledPageUrl(requestedUrl, page.url(), startUrl);
        rememberVisited(visited, url);

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
          const detail = err instanceof Error ? err.message : String(err);
          logModelDetail(`explorer.summarisePage ${url}`, detail);
          const message = `Page summary from the model was incomplete for ${url}; continuing with the page title.`;
          warnings.push(message);
          events.emit({
            phase: 'explorer', type: 'explore.warning',
            message,
            data: { url, detail },
          });
          summary = {
            summary: skeleton.title || `Page at ${url}`,
            interactive: [],
            authGated: false,
          };
        }

        const forms = skeleton.forms.filter(form => form.action || form.fields.length > 0 || form.submitLabel);
        const controls = skeleton.controls.filter(control => control.label);
        const outbound = selectOutboundLinks(linksOnCrawlSite(skeleton.links, startUrl));

        const sm: SiteMapPage = {
          url,
          title: skeleton.title,
          summary: summary.summary,
          interactive: withScrapedForm(summary.interactive, forms),
          outboundLinks: outbound.map(link => link.url),
          ...(forms.length ? { forms } : {}),
          ...(controls.length ? { controls } : {}),
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
        failures.push({ url: requestedUrl, reason });
        events.emit({
          phase: 'explorer', type: 'explore.page_failed',
          message: `Failed to load ${requestedUrl}`,
          data: { url: requestedUrl, reason },
        });
      } finally {
        await page.close().catch(() => {});
      }

    }

    const overall = await summariseSiteBestEffort(llm, startUrl, pages, (message, detail) => {
      warnings.push(message);
      events.emit({
        phase: 'explorer', type: 'explore.warning',
        message,
        data: { detail },
      });
    });

    events.emit({
      phase: 'explorer', type: 'explore.complete',
      message: `Crawl complete: ${pages.length} page${pages.length === 1 ? '' : 's'} visited`
        + (failures.length ? `, ${failures.length} failed.` : '.'),
      data: {
        siteType: overall.siteType,
        pagesVisited: pages.length,
        pagesFailed: failures.length,
        ...(warnings.length ? { warnings } : {}),
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
      ...(warnings.length ? { warnings } : {}),
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
  controls: SiteMapControl[];
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

    function fieldLabel(el: Element): string {
      const control = el as HTMLInputElement;
      if (control.id) {
        const byFor = document.querySelector(`label[for="${CSS.escape(control.id)}"]`);
        if (byFor) {
          const text = txt(byFor);
          if (text) return text.slice(0, 80);
        }
      }
      const aria = control.getAttribute('aria-label');
      if (aria && aria.trim()) return aria.trim().replace(/\s+/g, ' ').slice(0, 80);
      const labelledBy = control.getAttribute('aria-labelledby');
      if (labelledBy) {
        const text = labelledBy.split(/\s+/).map(id => {
          const node = document.getElementById(id);
          return node ? txt(node) : '';
        }).filter(Boolean).join(' ').trim();
        if (text) return text.slice(0, 80);
      }
      const parent = control.closest('label');
      if (parent) {
        const clone = parent.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('input, textarea, select').forEach(node => node.remove());
        const text = txt(clone);
        if (text) return text.slice(0, 80);
      }
      return '';
    }

    const forms = Array.from(document.querySelectorAll('form')).slice(0, 10).map(f => {
      const form = f as HTMLFormElement;
      const controls = Array.from(form.querySelectorAll('input, textarea, select')).flatMap(i => {
        const el = i as HTMLInputElement;
        const type = (el.type || el.tagName || '').toLowerCase();
        if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'image' || type === 'reset') return [];
        const name = el.name || '';
        const placeholder = el.placeholder || '';
        const label = fieldLabel(el);
        const token = name || placeholder || type;
        if (!token) return [];
        return [{
          token,
          ...(name ? { name } : {}),
          ...(label ? { label } : {}),
          ...(placeholder ? { placeholder } : {}),
          ...(type ? { type } : {}),
        }];
      });
      const submit = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
      const submitLabel = submit ? (txt(submit) || (submit as HTMLInputElement).value || '') : '';
      return {
        action: form.action || '',
        method: (form.method || 'get').toLowerCase(),
        fields: controls.map(control => control.token),
        ...(controls.length ? {
          inputs: controls.map(control => ({
            ...(control.name ? { name: control.name } : {}),
            ...(control.label ? { label: control.label } : {}),
            ...(control.placeholder ? { placeholder: control.placeholder } : {}),
            ...(control.type ? { type: control.type } : {}),
          })),
        } : {}),
        ...(submitLabel ? { submitLabel: submitLabel.slice(0, 80) } : {}),
      };
    });

    const buttonControls = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]'))
      .map(b => {
        const label = (txt(b) || (b as HTMLInputElement).value || '').slice(0, 80);
        const disabled = Boolean((b as HTMLButtonElement).disabled) || b.getAttribute('aria-disabled') === 'true';
        return { kind: 'button' as const, label, ...(disabled ? { disabled: true } : {}) };
      })
      .filter(control => control.label);
    const buttons = [
      ...buttonControls.filter(control => control.disabled),
      ...buttonControls.filter(control => !control.disabled),
    ].slice(0, 40);

    const linkControls = links
      .filter(link => link.text)
      .slice(0, 40)
      .map(link => ({ kind: 'link' as const, label: link.text.slice(0, 80), href: link.url }));

    const visibleText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 2200);

    return { headings, links, forms, buttons: buttons.map(control => control.label), controls: [...buttons, ...linkControls], visibleText };

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
    controls: collected.controls,
  };

}

/* ── LLM: per-page summary ────────────────────────────────────────────── */

const INTERACTIVE_KINDS = ['form', 'button', 'link', 'input', 'menu'] as const;
const INTERACTIVE_KIND_ALIASES: Record<string, typeof INTERACTIVE_KINDS[number]> = {
  cta: 'button',
  submit: 'button',
  anchor: 'link',
  hyperlink: 'link',
  textbox: 'input',
  field: 'input',
  textarea: 'input',
  dropdown: 'menu',
  nav: 'menu',
  navigation: 'menu',
};

const InteractiveItemSchema = z.object({
  kind: z.enum(INTERACTIVE_KINDS),
  label: z.string().min(1).max(80),
  selector: z.string().min(1).max(200).optional(),
});

function coerceInteractiveItem(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const kind = coerceEnum(record.kind ?? record.type ?? record.role, INTERACTIVE_KINDS, INTERACTIVE_KIND_ALIASES);
  const label = coerceProse(record.label ?? record.name ?? record.text ?? record.title);
  const selector = coerceToString(record.selector ?? record.css);
  return {
    ...(kind ? { kind } : {}),
    ...(label ? { label: clipText(label, 80) } : {}),
    ...(selector ? { selector: clipText(selector, 200) } : {}),
  };
}

function coerceInteractiveList(value: unknown): SiteMapInteractive[] | undefined {
  if (value == null) return undefined;
  const rawList = Array.isArray(value) ? value.flat(2) : [value];
  const items: SiteMapInteractive[] = [];
  for (const item of rawList) {
    const parsed = InteractiveItemSchema.safeParse(coerceInteractiveItem(item));
    if (!parsed.success) continue;
    items.push(parsed.data.selector
      ? parsed.data
      : { kind: parsed.data.kind, label: parsed.data.label });
    if (items.length >= 10) break;
  }
  return items;
}

export const PageSummarySchema = z.preprocess(
  (value) => unwrapModelObject(value, ['summary', 'authGated', 'interactive']),
  z.object({
    summary: z.preprocess(
      (value) => {
        const text = coerceProse(value);
        return text ? clipText(text, 400) : value;
      },
      z.string().min(3).max(400),
    ),
    // Unrecognised values become false. The previous failure path stored false
    // anyway and dropped the sentence; keeping the sentence is more useful.
    authGated: z.preprocess((value) => coerceBoolean(value) ?? false, z.boolean()),
    interactive: z.preprocess(
      (value) => coerceInteractiveList(value) ?? [],
      z.array(InteractiveItemSchema).max(10),
    ),
  }),
);

async function summarisePageWithLLM(
  llm: LLM,
  url: string,
  skeleton: PageSkeleton
): Promise<{ summary: string; authGated: boolean; interactive: SiteMapInteractive[] }> {

  const prompt = `
You are a QA analyst inspecting a single web page during an exploratory crawl.
Based on the page metadata below, return JSON with three fields:

  - "summary": one sentence (max 30 words) naming the page's job for a visitor (e.g. "CRED marketing homepage promoting credit-card rewards"). A string, not an object.
  - "authGated": boolean true or false — true only if the page is a login/OTP wall, or clearly requires an existing session. A marketing page that merely links to Sign in is NOT auth-gated. Do not send "yes"/"no" strings; use JSON booleans.
  - "interactive": an array of up to 10 important elements (primary CTAs first). Each item is an object, never a bare string:
        kind     — exactly one of "form" | "button" | "link" | "input" | "menu" (lowercase)
        label    — a short string (max 60 chars)
        selector — optional CSS selector string. Omit the key if you are not sure. Do not send null.

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

  const raw = await llm.generateJSON({
    label: 'explorer.summarisePage',
    prompt,
    schema: PageSummarySchema,
  });
  const parsed = PageSummarySchema.parse(raw);

  return {
    summary: parsed.summary,
    authGated: parsed.authGated,
    interactive: parsed.interactive ?? [],
  };

}

/* ── LLM: whole-site summary ──────────────────────────────────────────── */

const SITE_SUMMARY_FALLBACK_WARNING =
  'Site summary from the model was incomplete; continuing with a basic map of the site.';

function llmProseField(min: number, max: number) {
  return z.preprocess((value) => {
    const text = coerceProse(value);
    return text ? clipText(text, max) : value;
  }, z.string().min(min).max(max));
}

function llmOptionalProse(max: number) {
  return z.preprocess((value) => {
    if (value == null || value === '') return undefined;
    const text = coerceProse(value);
    return text ? clipText(text, max) : undefined;
  }, z.string().min(1).max(max).optional());
}

function llmStringListField(minLength: number, maxItems: number) {
  return z.preprocess((value) => {
    if (value == null) return undefined;
    const list = coerceStringList(value, { minLength, maxItems });
    return list ?? undefined;
  }, z.array(z.string().min(minLength)).max(maxItems).optional());
}

export const SiteSummarySchema = z.preprocess(
  (value) => unwrapModelObject(value, ['siteType', 'summary', 'authSurfaces', 'publicJourneys', 'productName']),
  z.object({
    siteType: llmProseField(2, 80),
    summary: llmProseField(3, 1200),
    productName: llmOptionalProse(120),
    publicJourneys: llmStringListField(3, 6),
    authSurfaces: llmStringListField(2, 6),
  }),
);

interface SiteSummaryFields {
  siteType: string;
  summary: string;
  productName?: string;
  publicJourneys?: string[];
  authSurfaces?: string[];
}

async function summariseSiteWithLLM(
  llm: LLM,
  startUrl: string,
  pages: SiteMapPage[]
): Promise<SiteSummaryFields> {

  if (pages.length === 0){
    return { siteType: 'unknown', summary: 'No pages were successfully visited.' };
  }

  const prompt = `
You just finished exploring a website as an anonymous visitor (you never logged in).
Understand the product, then describe it so a QA architect can design real user tests.

Return JSON:
  - "siteType": short category string, e.g. "ecommerce", "fintech consumer app", "saas marketing site",
                "blog", "documentation", "marketplace", "internal tool", "other".
  - "productName": brand or product name string if obvious, else omit the key.
  - "summary":  a string of 2–3 sentences (max 90 words): what the product does, who the visitor is,
                and which jobs they can complete WITHOUT an account.
  - "publicJourneys": an array of up to 5 short strings. Each item is one sentence
                (e.g. "Read credit-card benefits and open Apply"), never an object. Do not invent pages.
  - "authSurfaces": an array of short strings only, one per login / signup / OTP wall
                (e.g. "Login (/login)"). Never objects with url/label keys. Empty array if none.

Start URL: ${startUrl}

Pages visited:
${pages.map(p => `  - ${p.url}\n      title: ${p.title}\n      auth-gated: ${p.authGated}\n      summary: ${p.summary}\n      interactive: ${p.interactive.map(i => i.label).join(', ') || '(none)'}`).join('\n')}

Reply with JSON only.
`;

  const raw = await llm.generateJSON({
    label: 'explorer.summariseSite',
    prompt,
    schema: SiteSummarySchema,
  });
  return normaliseSiteSummary(SiteSummarySchema.parse(raw));

}

/**
 * Whole-site summary is best-effort. A schema miss used to abort the crawl
 * after every page had already been visited. Keep the pages and substitute a
 * map built from titles and URLs.
 */
async function summariseSiteBestEffort(
  llm: LLM,
  startUrl: string,
  pages: SiteMapPage[],
  onFallback: (message: string, detail: string) => void,
): Promise<SiteSummaryFields> {
  try {
    return await summariseSiteWithLLM(llm, startUrl, pages);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logModelDetail('explorer.summariseSite', detail);
    onFallback(SITE_SUMMARY_FALLBACK_WARNING, detail);
    return fallbackSiteSummary(startUrl, pages);
  }
}

function normaliseSiteSummary(parsed: z.infer<typeof SiteSummarySchema>): SiteSummaryFields {
  return {
    siteType: parsed.siteType,
    summary: parsed.summary,
    productName: parsed.productName ?? undefined,
    publicJourneys: parsed.publicJourneys ?? undefined,
    authSurfaces: parsed.authSurfaces ?? undefined,
  };
}

/** Crawl metadata when the model summary cannot be used. No page is invented. */
export function fallbackSiteSummary(startUrl: string, pages: SiteMapPage[]): SiteSummaryFields {
  if (pages.length === 0) {
    return { siteType: 'unknown', summary: 'No pages were successfully visited.' };
  }
  const host = hostOf(startUrl);
  const titles = uniqueStrings(pages.map(page => page.title.trim()).filter(title => title.length >= 2)).slice(0, 4);
  const blurbs = pages.map(pageBlurb).filter((line): line is string => Boolean(line)).slice(0, 3);
  const lead = `Explored ${pages.length} page${pages.length === 1 ? '' : 's'} on ${host}.`;
  const summary = clipText(
    blurbs.length
      ? `${lead} ${blurbs.join(' ')}`
      : `${lead}${titles.length ? ` Pages include ${titles.join(', ')}.` : ''}`,
    600,
  );
  const publicJourneys = uniqueStrings(pages.filter(page => !page.authGated).map(page => {
    const label = page.title.trim() || pathLabel(page.url);
    return label.length >= 3 ? `Visit ${label}` : '';
  })).slice(0, 5);
  const authSurfaces = uniqueStrings(pages.filter(page => page.authGated || looksLikeAuthUrl(page.url)).map(page => {
    const label = page.title.trim();
    if (label.length >= 2) return `${label} (${page.url})`;
    return page.url.length >= 2 ? page.url : '';
  })).slice(0, 6);
  return {
    siteType: inferSiteType(startUrl, pages),
    summary,
    ...(publicJourneys.length ? { publicJourneys } : {}),
    ...(authSurfaces.length ? { authSurfaces } : {}),
  };
}

function pageBlurb(page: SiteMapPage): string | undefined {
  const summary = page.summary.trim();
  if (summary.length < 3) return undefined;
  if (/schema|LLM summary unavailable|did not match/i.test(summary)) return undefined;
  if (summary === page.title.trim()) return undefined;
  return summary;
}

function inferSiteType(startUrl: string, pages: SiteMapPage[]): string {
  const blob = [startUrl, ...pages.map(page => `${page.url} ${page.title} ${page.summary}`)].join(' ').toLowerCase();
  if (/\b(cart|checkout|product|shop|store)\b/.test(blob)) return 'ecommerce';
  if (/\b(docs|documentation|api reference)\b/.test(blob)) return 'documentation';
  if (/\bblog\b/.test(blob)) return 'blog';
  if (/\b(pricing|dashboard|sign in|log in)\b/.test(blob)) return 'saas marketing site';
  return 'website';
}

function hostOf(startUrl: string): string {
  try { return new URL(startUrl).hostname.replace(/^www\./, ''); }
  catch { return startUrl; }
}

function pathLabel(value: string): string {
  try {
    const path = new URL(value).pathname.replace(/\/+$/, '');
    const last = path.split('/').filter(Boolean).pop();
    return last || '';
  } catch {
    return '';
  }
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
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
