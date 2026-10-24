/**
 * Guarantee a few grounded flows for fault surfaces the crawl actually saw.
 *
 * A public form is handled next door in `forms.ts`. This pass adds, when
 * `maxFlows` has room (or by replacing a leftover model flow):
 *
 *   1. one enabled button that is not that form's submit control
 *   2. one same-origin link whose target the crawl did not successfully open
 *   3. one disabled button that is not a form submit
 *
 * Deeper pages win over the start URL so a homepage full of nav links does
 * not consume the slot. Nothing is invented: every label and URL comes from
 * `SiteMapPage.controls`.
 */

import type { SiteMap, SiteMapPage, TestFlow } from '../types.js';
import { canonicalPageUrl, looksLikeAuthUrl } from '../explorer/queue.js';

const NAV_LABEL = /^(home|back|back home|back to home|menu|skip|skip to content|logo)$/i;

export interface FaultFlowResult {
  flows: TestFlow[];
  /** Labels of flows this pass inserted. */
  added: string[];
}

export function ensureFaultSurfaceFlows(
  flows: TestFlow[],
  siteMap: SiteMap,
  maxFlows: number,
): FaultFlowResult {
  if (maxFlows < 1) return { flows: [], added: [] };
  let next = flows.slice(0, maxFlows);
  const added: string[] = [];

  for (const candidate of faultCandidates(siteMap)) {
    if (alreadyCovers(next, candidate.page.url, candidate.label)) continue;
    if (next.length >= maxFlows) {
      const removable = lastModelFlow(next);
      if (removable < 0) break;
      next.splice(removable, 1);
    }
    next.push(candidate.flow);
    added.push(candidate.label);
  }

  return { flows: next.slice(0, maxFlows), added };
}

interface Candidate {
  page: SiteMapPage;
  label: string;
  flow: TestFlow;
}

function faultCandidates(siteMap: SiteMap): Candidate[] {
  const start = canonicalPageUrl(siteMap.startUrl);
  const visited = new Set(siteMap.pages.map(page => canonicalPageUrl(page.url)));
  const pages = siteMap.pages.filter(page => !page.authGated && !looksLikeAuthUrl(page.url));
  const ordered = [
    ...pages.filter(page => canonicalPageUrl(page.url) !== start),
    ...pages.filter(page => canonicalPageUrl(page.url) === start),
  ];

  const buttons: Candidate[] = [];
  const links: Candidate[] = [];
  const disabled: Candidate[] = [];
  const seen = new Set<string>();

  for (const page of ordered) {
    const submits = new Set(
      (page.forms ?? [])
        .map(form => (form.submitLabel || '').trim().toLowerCase())
        .filter(Boolean),
    );
    for (const control of page.controls ?? []) {
      const label = control.label.trim();
      if (!label) continue;
      const key = `${control.kind}:${label.toLowerCase()}`;
      if (seen.has(key)) continue;

      if (control.kind === 'button') {
        if (submits.has(label.toLowerCase())) continue;
        seen.add(key);
        const bucket = control.disabled ? disabled : buttons;
        bucket.push(buildCandidate(page, label, control.disabled ? 'disabled' : 'button'));
        continue;
      }

      if (control.kind !== 'link') continue;
      if (NAV_LABEL.test(label)) continue;
      if (!control.href || !sameOrigin(page.url, control.href)) continue;
      if (looksLikeAuthUrl(control.href)) continue;
      if (visited.has(canonicalPageUrl(control.href))) continue;
      seen.add(key);
      links.push(buildCandidate(page, label, 'link'));
    }
  }

  return [buttons[0], links[0], disabled[0]].filter((item): item is Candidate => Boolean(item));
}

function buildCandidate(page: SiteMapPage, label: string, kind: 'button' | 'link' | 'disabled'): Candidate {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'control';
  const expectation = kind === 'disabled'
    ? `The "${label}" control is enabled and responds.`
    : kind === 'link'
      ? `The "${label}" link opens a page that exists.`
      : `The "${label}" control runs without a page error.`;
  return {
    page,
    label,
    flow: {
      id: `fault-${kind}-${slug}`,
      name: `${kind === 'link' ? 'Open' : 'Use'} ${label}`.slice(0, 80),
      description: `Exercise the ${kind === 'link' ? 'link' : 'button'} "${label}" scraped from ${page.url}.`,
      kind: 'happy_path',
      startUrl: page.url,
      steps: [{ action: `Click "${label}"`, expectation }],
      expectation,
      severityIfFails: 'critical',
    },
  };
}

function alreadyCovers(flows: TestFlow[], pageUrl: string, label: string): boolean {
  const page = canonicalPageUrl(pageUrl);
  const needle = label.toLowerCase();
  return flows.some(flow =>
    canonicalPageUrl(flow.startUrl) === page
    && flow.steps.some(step => step.action.toLowerCase().includes(needle)),
  );
}

/** Model flows can be replaced. Form and fault flows this engine inserted cannot. */
function lastModelFlow(flows: TestFlow[]): number {
  for (let i = flows.length - 1; i >= 0; i--) {
    const id = flows[i].id;
    if (id === 'public-form-submit' || id.startsWith('fault-')) continue;
    return i;
  }
  return -1;
}

function sameOrigin(pageUrl: string, href: string): boolean {
  try {
    return new URL(href, pageUrl).origin === new URL(pageUrl).origin;
  } catch {
    return false;
  }
}
