/**
 * Quick pass bias: forms, search, and primary calls to action.
 *
 * The public-form floor and the fault-surface floor still run. This pass
 * then spends the flow budget on a search box and primary buttons, and does
 * not keep a disabled control while those are available.
 */

import type { SiteMap, SiteMapForm, SiteMapPage, TestFlow } from '../types.js';
import { looksLikeAuthUrl, sameCrawlPage } from '../explorer/queue.js';
import { isSearchBox } from './forms.js';

const CTA_RE = /\b(get started|sign up|signup|apply|buy now|contact|book|subscribe|try|start free|shop now|add to|search|send|continue|checkout|donate|join)\b/i;

export function applyFormsSearchCtaFocus(
  flows: TestFlow[],
  siteMap: SiteMap,
  maxFlows: number,
): { flows: TestFlow[]; note?: string } {
  if (maxFlows < 1) return { flows: [] };

  const picked: TestFlow[] = [];
  const push = (flow: TestFlow | undefined) => {
    if (!flow || picked.length >= maxFlows) return;
    if (picked.some(existing => existing.id === flow.id)) return;
    if (picked.some(existing => sameJourney(existing, flow))) return;
    picked.push(flow);
  };

  push(flows.find(flow => flow.id === 'public-form-submit'));

  const search = findSearchTarget(siteMap);
  if (search && !picked.some(flow => sameCrawlPage(flow.startUrl, search.page.url) && coversSearch(flow, search.form))) {
    push(searchFlow(search.page, search.form));
  }

  for (const cta of primaryCtas(siteMap, flows)) push(cta);

  for (const flow of flows) {
    if (isDisabledFault(flow)) continue;
    push(flow);
  }

  return {
    flows: picked.slice(0, maxFlows),
    note: 'Quick pass kept journeys biased to forms, search, and primary calls to action.',
  };
}

function isDisabledFault(flow: TestFlow): boolean {
  return flow.id.startsWith('fault-disabled');
}

function sameJourney(left: TestFlow, right: TestFlow): boolean {
  if (left.id === right.id) return true;
  const action = right.steps.map(step => step.action).join(' ').toLowerCase();
  return sameCrawlPage(left.startUrl, right.startUrl)
    && left.steps.every(step => action.includes(step.action.toLowerCase()));
}

interface SearchTarget {
  page: SiteMapPage;
  form: SiteMapForm;
}

function findSearchTarget(siteMap: SiteMap): SearchTarget | undefined {
  for (const page of siteMap.pages) {
    if (page.authGated || looksLikeAuthUrl(page.url)) continue;
    for (const form of page.forms ?? []) {
      if (isSearchBox(page.url, form)) return { page, form };
    }
  }
  return undefined;
}

function coversSearch(flow: TestFlow, form: SiteMapForm): boolean {
  const text = flow.steps.map(step => step.action).join(' ').toLowerCase();
  const field = (form.fields[0] || form.inputs?.[0]?.label || form.inputs?.[0]?.name || 'search').toLowerCase();
  return text.includes(field) || /\bsearch\b/.test(text);
}

function searchFlow(page: SiteMapPage, form: SiteMapForm): TestFlow {
  const field = clean(form.inputs?.[0]?.label || form.inputs?.[0]?.name || form.fields[0] || 'search');
  const submit = clean(form.submitLabel || 'Search');
  return {
    id: 'quick-search',
    name: `Search from ${clean(page.title || 'this page')}`.slice(0, 80),
    description: `Use the search box discovered at ${page.url}.`,
    kind: 'happy_path',
    startUrl: page.url,
    steps: [
      {
        action: `Fill the "${field}" field${form.inputs?.[0]?.name ? ` (name="${clean(form.inputs[0].name)}")` : ''} on the search form`,
        expectation: 'The search field accepts a value.',
      },
      {
        action: `Submit the search form by clicking "${submit}"`,
        expectation: 'Search runs and the site does not return a server error.',
      },
    ],
    expectation: 'Search runs without a server error.',
    severityIfFails: 'major',
  };
}

function primaryCtas(siteMap: SiteMap, flows: TestFlow[]): TestFlow[] {
  const found: { page: SiteMapPage; label: string; score: number }[] = [];
  const seen = new Set<string>();
  for (const page of siteMap.pages) {
    if (page.authGated || looksLikeAuthUrl(page.url)) continue;
    const submits = new Set(
      (page.forms ?? []).map(form => (form.submitLabel || '').trim().toLowerCase()).filter(Boolean),
    );
    for (const control of page.controls ?? []) {
      if (control.kind !== 'button' || control.disabled) continue;
      const label = control.label.trim();
      if (!label || submits.has(label.toLowerCase())) continue;
      const key = label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ page, label, score: CTA_RE.test(label) ? 2 : 1 });
    }
  }
  found.sort((a, b) => b.score - a.score);
  return found.slice(0, 2).map(item => {
    const existing = flows.find(flow =>
      sameCrawlPage(flow.startUrl, item.page.url)
      && flow.steps.some(step => step.action.toLowerCase().includes(item.label.toLowerCase())),
    );
    return existing ?? ctaFlow(item.page, item.label);
  });
}

function ctaFlow(page: SiteMapPage, label: string): TestFlow {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'cta';
  return {
    id: `quick-cta-${slug}`,
    name: `Use ${label}`.slice(0, 80),
    description: `Activate the primary control "${label}" on ${page.url}.`,
    kind: 'happy_path',
    startUrl: page.url,
    steps: [{
      action: `Click "${label}"`,
      expectation: `The "${label}" control runs without a page error.`,
    }],
    expectation: `The "${label}" control runs without a page error.`,
    severityIfFails: 'major',
  };
}

function clean(value: string): string {
  return value.replace(/\s+/g, ' ').trim().replace(/["“”]/g, "'").slice(0, 80);
}
