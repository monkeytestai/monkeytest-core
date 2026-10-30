/**
 * Guarantee a form-submit flow when the crawl actually saw a public form.
 *
 * The planner LLM is still asked to do this. The slot is reserved either way:
 * a valid shopping-only plan, and a plan that only vaguely says "submit" on
 * the form page, both keep the grounded flow. Its URL, action, and fields
 * come from the sitemap. Nothing is invented.
 *
 * When that form sits on a help, contact, or support page, this flow is the
 * help exploration. A model flow that only reads such a page is dropped after
 * shop flows, so it survives a full quota.
 */

import type { SiteMap, SiteMapForm, SiteMapPage, TestFlow } from '../types.js';
import { isFormSurfaceLink, looksLikeAuthUrl, sameCrawlPage } from '../explorer/queue.js';

export interface RankedForm {
  page: SiteMapPage;
  form: SiteMapForm;
  score: number;
}

/**
 * A header search box. It must not take the public-form slot, and Quick pass
 * still gets its own search journey from the same check.
 */
export function isSearchBox(pageUrl: string, form: SiteMapForm): boolean {
  if (looksLikeAuthUrl(pageUrl)) return false;
  const method = (form.method || 'get').toLowerCase();
  const actionPath = pathOf(form.action);
  const fields = form.fields.join(' ');
  const typedSearch = (form.inputs || []).some(input => (input.type || '').toLowerCase() === 'search');
  return typedSearch
    || /\/search(?:\/|$|\?)/i.test(actionPath)
    || (method !== 'post' && form.fields.length <= 1 && /\b(q|query|search)\b/i.test(fields));
}

/** Prefer a POST contact/help form over a header search box. */
export function scorePublicForm(pageUrl: string, form: SiteMapForm): number {
  if (looksLikeAuthUrl(pageUrl)) return -1;
  const method = (form.method || 'get').toLowerCase();
  const action = form.action || '';
  let score = 0;
  if (isFormSurfaceLink({ url: pageUrl, text: form.submitLabel })) score += 50;
  if (action && isFormSurfaceLink({ url: action, text: form.submitLabel })) score += 50;
  if (method === 'post') score += 30;
  if (form.fields.length > 0) score += 5;
  if (form.submitLabel) score += 5;
  if (isSearchBox(pageUrl, form)) score -= 40;
  return score;
}

export function bestPublicForm(siteMap: SiteMap): RankedForm | undefined {
  let best: RankedForm | undefined;
  for (const page of siteMap.pages) {
    if (page.authGated || looksLikeAuthUrl(page.url)) continue;
    for (const form of page.forms ?? []) {
      const score = scorePublicForm(page.url, form);
      if (score < 30) continue;
      if (!best || score > best.score) best = { page, form, score };
    }
  }
  return best;
}

/**
 * True when a model flow is an attempt at the same page's form.
 * Callers still install the grounded flow; this only drops the duplicate.
 */
export function flowCoversForm(flow: TestFlow, pageUrl: string): boolean {
  if (!sameCrawlPage(flow.startUrl, pageUrl)) return false;
  const text = flow.steps.map(step => step.action).join(' ').toLowerCase();
  return /\b(submit|send)\b/.test(text);
}

/** Form and fault flows stay. Shop flows are what a full quota gives up. */
export function isReservedFlowId(id: string): boolean {
  return id === 'public-form-submit' || id.startsWith('fault-');
}

export function ensurePublicFormFlow(
  flows: TestFlow[],
  siteMap: SiteMap,
  maxFlows: number,
): { flows: TestFlow[]; injected: boolean } {
  if (maxFlows < 1) return { flows: [], injected: false };
  const target = bestPublicForm(siteMap);
  if (!target) return { flows: fitModelFlows(flows, maxFlows), injected: false };

  const grounded = buildFormFlow(target);
  const rest = flows.filter(flow => flow.id !== grounded.id && !flowCoversForm(flow, target.page.url));
  return {
    flows: [grounded, ...fitModelFlows(rest, maxFlows - 1)].slice(0, maxFlows),
    injected: true,
  };
}

/**
 * Shrink to `budget` model flows. Drop shop and product journeys before a
 * flow that starts on a help, contact, support, or about page the crawl saw.
 */
function fitModelFlows(flows: TestFlow[], budget: number): TestFlow[] {
  const next = flows.slice();
  const room = Math.max(0, budget);
  while (next.length > room) {
    const index = indexToDrop(next);
    if (index < 0) break;
    next.splice(index, 1);
  }
  return next.slice(0, room);
}

function indexToDrop(flows: TestFlow[]): number {
  let surfaceFallback = -1;
  for (let i = flows.length - 1; i >= 0; i--) {
    if (isReservedFlowId(flows[i].id)) continue;
    if (!isFormSurfaceLink({ url: flows[i].startUrl })) return i;
    if (surfaceFallback < 0) surfaceFallback = i;
  }
  return surfaceFallback;
}

interface FieldHint {
  quoted: string;
  name?: string;
}

function fieldHints(form: SiteMapForm): FieldHint[] {
  if (form.inputs && form.inputs.length > 0) {
    return form.inputs.slice(0, 6).flatMap(input => {
      const quoted = cleanQuote(input.label || input.name || input.placeholder || input.type || '');
      if (!quoted) return [];
      const name = input.name ? cleanQuote(input.name) : undefined;
      return [{ quoted, ...(name ? { name } : {}) }];
    });
  }
  return form.fields.filter(Boolean).slice(0, 6).map(token => ({ quoted: cleanQuote(token) }));
}

function cleanQuote(value: string): string {
  return value.replace(/\s+/g, ' ').trim().replace(/["“”]/g, "'").slice(0, 80);
}

function buildFormFlow(target: RankedForm): TestFlow {
  const { page, form } = target;
  const actionPath = pathOf(form.action);
  const where = actionPath ? ` on the form that submits to ${actionPath}` : ' on the form';
  const fields = fieldHints(form);
  const steps = [
    ...fields.map(field => ({
      action: `Fill the "${field.quoted}" field${field.name ? ` (name="${field.name}")` : ''}${where}`,
      expectation: `The ${field.quoted} field accepts a value.`,
    })),
    {
      action: form.submitLabel
        ? `Submit the form${actionPath ? ` that submits to ${actionPath}` : ''} by clicking "${form.submitLabel}"`
        : `Submit the form${actionPath ? ` that submits to ${actionPath}` : ''}`,
      expectation: 'The form submits and the site does not return a server error.',
    },
  ];
  const title = (page.title || 'this page').replace(/\s+/g, ' ').trim();
  return {
    id: 'public-form-submit',
    name: `Submit the form on ${title}`.slice(0, 80),
    description: `Submit the public form discovered at ${page.url}.`,
    kind: 'happy_path',
    startUrl: page.url,
    steps,
    expectation: 'The public form submits without a server error.',
    severityIfFails: 'critical',
  };
}

function pathOf(value: string | undefined): string {
  if (!value) return '';
  try {
    const url = new URL(value, 'https://form.invalid');
    return `${url.pathname}${url.search}`;
  } catch {
    return value;
  }
}
