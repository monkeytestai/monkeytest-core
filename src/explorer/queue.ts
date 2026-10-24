/**
 * Crawl-order helpers.
 *
 * The explorer used to walk links FIFO. On a shop homepage the first links
 * are category and product URLs, so a small `maxPages` never reaches the
 * contact form in the header or footer. These helpers keep that BFS, but
 * reserve a few slots for form / help / contact / support / about pages the
 * crawl actually saw. They never invent URLs.
 *
 * Scope is the site. `http://shop.example/` and `https://www.shop.example/help`
 * are the same site. Another subdomain, another host, or another explicit
 * port is not enqueued.
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

const CRAWL_ASSET = /\.(png|jpe?g|gif|svg|pdf|zip|ico|webp|avif|mp4|webm)(\?.*)?$/i;

/**
 * Identity of a page inside one crawl. `www` and the apex host are the same
 * page. `http` and `https` are the same page. An explicit port stays
 * distinct, so `:8080` is not `:80`.
 *
 * This is wider than the runner's HTTP 5xx host check on purpose. A start
 * URL of `http://shop.example/` often redirects to `https://www.shop.example/`,
 * and the crawl has to follow that. A 5xx on a different scheme is still a
 * different listener, so the oracle does not use this key.
 */
export function crawlPathKey(value: string): string | undefined {
  let url: URL;
  try { url = new URL(value); }
  catch { return undefined; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  const host = url.hostname.replace(/^www\./i, '').toLowerCase();
  const port = url.port ? `:${url.port}` : '';
  let path = url.pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return `${host}${port}${path}${url.search}`;
}

/** True when both URLs are the same path on the same crawl site. */
export function sameCrawlPage(a: string, b: string): boolean {
  if (canonicalPageUrl(a) === canonicalPageUrl(b)) return true;
  const left = crawlPathKey(a);
  const right = crawlPathKey(b);
  return Boolean(left && left === right);
}

/**
 * True when `href` is an http(s) document on the same site as `scope`.
 * `www` and the apex host match. `http` and `https` match. A non-default
 * port must match. Other subdomains, other hosts, `mailto:`, and common
 * asset types are not crawl targets.
 */
export function isSameCrawlSite(href: string, scope: string): boolean {
  let target: URL;
  let base: URL;
  try {
    base = new URL(scope);
    target = new URL(href, scope);
  } catch {
    return false;
  }
  if (!isHttpProtocol(target) || !isHttpProtocol(base)) return false;
  if (siteHost(target) !== siteHost(base)) return false;
  if ((target.port || '') !== (base.port || '')) return false;
  if (CRAWL_ASSET.test(target.pathname)) return false;
  return true;
}

/**
 * Links the explorer may enqueue. Off-site, asset, and non-http URLs are
 * dropped. The returned URL is canonical. Anchor text is kept so a footer
 * "Help" link is still recognised as a form surface.
 */
export function linksOnCrawlSite(links: DiscoveredLink[], scope: string): DiscoveredLink[] {
  const accepted: DiscoveredLink[] = [];
  for (const link of links) {
    if (!link.url) continue;
    const url = canonicalPageUrl(link.url);
    if (!isSameCrawlSite(url, scope)) continue;
    accepted.push(link.text ? { url, text: link.text } : { url });
  }
  return accepted;
}

/**
 * URL to record after navigation. Prefer the URL the browser settled on
 * when the redirect stayed on this site (`http://apex` → `https://www`).
 * An open redirect to another host keeps the URL we asked for, and its
 * links are not followed.
 */
export function crawledPageUrl(requested: string, landed: string, scope: string): string {
  const settled = canonicalPageUrl(landed);
  if (isSameCrawlSite(settled, scope)) return settled;
  return canonicalPageUrl(requested);
}

const SITE_PATH_PREFIX = 'site-path:';

/** Record a URL and its scheme/www-insensitive path so the twin is not crawled again. */
export function rememberVisited(visited: Set<string>, url: string): void {
  const canonical = canonicalPageUrl(url);
  visited.add(canonical);
  const key = crawlPathKey(canonical);
  if (key) visited.add(`${SITE_PATH_PREFIX}${key}`);
}

export function wasVisited(visited: ReadonlySet<string>, url: string): boolean {
  const canonical = canonicalPageUrl(url);
  if (visited.has(url) || visited.has(canonical)) return true;
  const key = crawlPathKey(canonical);
  return Boolean(key && visited.has(`${SITE_PATH_PREFIX}${key}`));
}

function isHttpProtocol(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

function siteHost(url: URL): string {
  return url.hostname.replace(/^www\./i, '').toLowerCase();
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
    if (!url || wasVisited(visited, url) || queueHas(queue, url)) continue;
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
 * links discovered on that page. Off-site links are dropped with the same
 * site rule `explore` uses, so an `http://` apex start whose anchors were
 * rewritten to `https://www` still reaches `/help`.
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
    if (!next || wasVisited(visited, next.url)) continue;
    rememberVisited(visited, next.url);
    order.push(next.url);
    if (isFormSurfaceLink({ url: next.url })) surfaceVisited += 1;
    const discovered = linksOnCrawlSite(edgesFor(input.edges, next.url), input.startUrl);
    authUrlsQueued = enqueueLinks(queue, visited, selectOutboundLinks(discovered), authUrlsQueued);
  }

  return order;
}

function edgesFor(edges: Record<string, DiscoveredLink[]>, url: string): DiscoveredLink[] {
  if (edges[url]) return edges[url];
  const canonical = canonicalPageUrl(url);
  if (edges[canonical]) return edges[canonical];
  const key = crawlPathKey(url);
  if (!key) return [];
  for (const [candidate, links] of Object.entries(edges)) {
    if (crawlPathKey(candidate) === key) return links;
  }
  return [];
}

function queueHas(queue: CrawlQueueItem[], url: string): boolean {
  const key = crawlPathKey(url);
  return queue.some(item => item.url === url || (key !== undefined && crawlPathKey(item.url) === key));
}
