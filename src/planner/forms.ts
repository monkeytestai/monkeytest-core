/**
 * Guarantee a form-submit flow when the crawl actually saw a public form.
 *
 * The planner LLM is still asked to do this. This pass is the floor: a small
 * model that only plans shop journeys cannot drop the contact form on the
 * floor. URLs and field names come from the sitemap. Nothing is invented.
 */

import type { SiteMap, SiteMapForm, SiteMapPage, TestFlow } from '../types.js';
import { canonicalPageUrl, isFormSurfaceLink, looksLikeAuthUrl } from '../explorer/queue.js';

export interface RankedForm {
  page: SiteMapPage;
  form: SiteMapForm;
  score: number;
}

/** Prefer a POST contact/help form over a header search box. */
export function scorePublicForm(pageUrl: string, form: SiteMapForm): number {
  if (looksLikeAuthUrl(pageUrl)) return -1;
  const method = (form.method || 'get').toLowerCase();
  const action = form.action || '';
  const actionPath = pathOf(action);
  const fields = form.fields.join(' ');
  let score = 0;
  if (isFormSurfaceLink({ url: pageUrl, text: form.submitLabel })) score += 50;
  if (action && isFormSurfaceLink({ url: action, text: form.submitLabel })) score += 50;
  if (method === 'post') score += 30;
  if (form.fields.length > 0) score += 5;
  if (form.submitLabel) score += 5;
  const searchBox = /\/search(?:\/|$|\?)/i.test(actionPath)
    || (method !== 'post' && form.fields.length <= 1 && /\b(q|query|search)\b/i.test(fields));
  if (searchBox) score -= 40;
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

export function flowCoversForm(flow: TestFlow, pageUrl: string): boolean {
  if (canonicalPageUrl(flow.startUrl) !== canonicalPageUrl(pageUrl)) return false;
  const text = flow.steps.map(step => step.action).join(' ').toLowerCase();
  return /\b(submit|send)\b/.test(text);
}

export function ensurePublicFormFlow(
  flows: TestFlow[],
  siteMap: SiteMap,
  maxFlows: number,
): { flows: TestFlow[]; injected: boolean } {
  if (maxFlows < 1) return { flows: [], injected: false };
  const target = bestPublicForm(siteMap);
  if (!target) return { flows: flows.slice(0, maxFlows), injected: false };
  if (flows.some(flow => flowCoversForm(flow, target.page.url))) {
    return { flows: flows.slice(0, maxFlows), injected: false };
  }

  const injected = buildFormFlow(target);
  const rest = flows.filter(flow => flow.id !== injected.id);
  if (rest.length >= maxFlows) rest.pop();
  return {
    flows: [injected, ...rest].slice(0, maxFlows),
    injected: true,
  };
}

function buildFormFlow(target: RankedForm): TestFlow {
  const { page, form } = target;
  const actionPath = pathOf(form.action);
  const where = actionPath ? ` on the form that submits to ${actionPath}` : ' on the form';
  const fields = form.fields.filter(Boolean).slice(0, 6);
  const steps = [
    ...fields.map(field => ({
      action: `Fill the "${field}" field${where}`,
      expectation: `The ${field} field accepts a value.`,
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
