/**
 * Crawl-order helpers.
 *
 * The explorer used to walk links FIFO. On a shop homepage the first links
 * are category and product URLs, so a small `maxPages` never reaches the
 * contact form in the header or footer. These helpers keep that BFS, but
 * reserve a few slots for form / help / contact / support / about pages the
 * crawl actually saw. They never invent URLs.
 */

export interface DiscoveredLink {
  url: string;
  text?: string;
}

export interface CrawlQueueItem {
  url: string;
  /** True when the URL or its anchor text looks like a public form surface. */
  surface: boolean;
}

const SURFACE_PATH = /(?:^|\/)(contact|contacts|help|support|about|faq|faqs|feedback|quote|enquiries|enquiry|inquiries|inquiry|customer-service|customer-care|get-in-touch|newsletter|subscribe)(?:\/|$|[?#])/i;

const SURFACE_TEXT = /\b(contact|help|support|about|faq|faqs|feedback|get in touch|customer service|customer care|send (us )?a message|write to us|newsletter|subscribe)\b/i;

/** Passed into the page so the scraper can keep footer/help links past a long product grid. */
export const FORM_SURFACE_PATH_SOURCE = SURFACE_PATH.source;
export const FORM_SURFACE_TEXT_SOURCE = SURFACE_TEXT.source;

const AUTH_PATH = /\/(login|log-in|signin|sign-in|signup|sign-up|register|otp|verify|forgot|reset-password|password|oauth|sso|auth)(\/|$|\?)/i;

export function canonicalPageUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    if (url.pathname.endsWith('/') && url.pathname.length > 1) {
      url.pathname = url.pathname.slice(0, -1);
    }
    return url.toString();
  } catch {
    return value;
  }
}

export function looksLikeAuthUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return AUTH_PATH.test(`${url.pathname}${url.search}`.toLowerCase());
  } catch {
    return false;
  }
}

/** Public form / help / contact / about style link. Auth walls are not surfaces. */
export function isFormSurfaceLink(link: DiscoveredLink): boolean {
  if (!link.url || looksLikeAuthUrl(link.url)) return false;
  let path = link.url;
  try {
    const url = new URL(link.url);
    path = `${url.pathname}${url.search}`;
  } catch { /* use the raw string */ }
  if (SURFACE_PATH.test(path)) return true;
  return Boolean(link.text && SURFACE_TEXT.test(link.text));
}

/**
 * How many visited pages should be form/help surfaces before the crawl goes
 * back to ordinary BFS. `maxPages` of 1 can only be the start URL.
 */
export function formReserveCount(maxPages: number): number {
  if (!Number.isFinite(maxPages) || maxPages <= 1) return 0;
  return Math.min(3, Math.max(1, Math.floor(maxPages / 3)));
}

/**
 * Keep every form-surface link (so a footer "Help" past a long product grid
 * is not dropped) plus the first `cap` ordinary links, in document order.
 */
export function selectOutboundLinks(links: DiscoveredLink[], cap = 80): DiscoveredLink[] {
  const seen = new Set<string>();
  const unique: DiscoveredLink[] = [];
  for (const link of links) {
    if (!link.url || seen.has(link.url)) continue;
    seen.add(link.url);
    unique.push(link);
  }
  const surfaceUrls = new Set(unique.filter(link => isFormSurfaceLink(link)).map(link => link.url));
  const ordinary = unique.filter(link => !surfaceUrls.has(link.url));
  const keptOrdinary = new Set(ordinary.slice(0, Math.max(0, cap)).map(link => link.url));
  return unique.filter(link => surfaceUrls.has(link.url) || keptOrdinary.has(link.url));
}

/** Index to visit next. Form surfaces jump the queue until the reserve is filled. */
export function pickNextCrawlUrl(
  queue: CrawlQueueItem[],
  opts: { pagesVisited: number; maxPages: number; surfaceVisited: number },
): number {
  if (queue.length === 0) return -1;
  if (opts.pagesVisited >= opts.maxPages) return -1;
  if (opts.surfaceVisited < formReserveCount(opts.maxPages)) {
    const surface = queue.findIndex(item => item.surface);
    if (surface >= 0) return surface;
  }
  return 0;
}

export function enqueueLinks(
  queue: CrawlQueueItem[],
  visited: ReadonlySet<string>,
  links: DiscoveredLink[],
  authUrlsQueued: number,
  authLimit = 1,
): number {
  let authQueued = authUrlsQueued;
  for (const link of links) {
    const url = canonicalPageUrl(link.url);
    if (!url || visited.has(url) || queue.some(item => item.url === url)) continue;
    const auth = looksLikeAuthUrl(url);
    if (auth) {
      if (authQueued >= authLimit) continue;
      authQueued += 1;
    }
    queue.push({ url, surface: isFormSurfaceLink({ url, text: link.text }) });
  }
  return authQueued;
}

/**
 * Pure stand-in for the explorer loop. `edges` maps a visited URL to the
 * links discovered on that page. Used to prove a shop-heavy homepage still
 * reaches `/help` under a small `maxPages`.
 */
export function planCrawlOrder(input: {
  startUrl: string;
  maxPages: number;
  edges: Record<string, DiscoveredLink[]>;
}): string[] {
  const start = canonicalPageUrl(input.startUrl);
  const queue: CrawlQueueItem[] = [{ url: start, surface: isFormSurfaceLink({ url: start }) }];
  const visited = new Set<string>();
  const order: string[] = [];
  let surfaceVisited = 0;
  let authUrlsQueued = 0;

  while (order.length < input.maxPages) {
    const index = pickNextCrawlUrl(queue, {
      pagesVisited: order.length,
      maxPages: input.maxPages,
      surfaceVisited,
    });
    if (index < 0) break;
    const next = queue.splice(index, 1)[0];
    if (!next || visited.has(next.url)) continue;
    visited.add(next.url);
    order.push(next.url);
    if (isFormSurfaceLink({ url: next.url })) surfaceVisited += 1;
    const discovered = (input.edges[next.url] ?? []).map(link => ({
      ...link,
      url: canonicalPageUrl(link.url),
    }));
    authUrlsQueued = enqueueLinks(queue, visited, selectOutboundLinks(discovered), authUrlsQueued);
  }

  return order;
}
