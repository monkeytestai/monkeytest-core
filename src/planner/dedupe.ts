/**
 * Phase-1 flow dedupe.
 *
 * Two journeys that click the same control label on the same page collapse
 * to one. Clicks on off-site or OAuth controls ("Continue with Google") are
 * dropped. `auth-neg-*` flows are kept even when they share a submit label,
 * because each one asserts a different sign-in failure. A non-engine flow
 * that repeats one of those labels is the one that is dropped.
 */

import type { SiteMap, TestFlow } from '../types.js';
import { canonicalPageUrl, crawlPathKey, isSameCrawlSite, sameCrawlPage } from '../explorer/queue.js';
import { isAuthNegativeFlowId } from './authNegative.js';

const OAUTH_LABEL = /\b(continue with|sign in with|log in with|login with|sign up with|signup with)\b|\boauth\b|\bsso\b|\baccounts\.google\b|\bgoogle\b|\bfacebook\b|\bgithub\b|\bapple\b|\bmicrosoft\b/i;

export interface DedupeResult {
  flows: TestFlow[];
  dropped: string[];
}

export function dedupePlannedFlows(flows: TestFlow[], siteMap: SiteMap): DedupeResult {
  const seen = new Set<string>();
  for (const flow of flows) {
    if (!isAuthNegativeFlowId(flow.id)) continue;
    const key = clickKey(flow);
    if (key) seen.add(key);
  }

  const kept: TestFlow[] = [];
  const dropped: string[] = [];
  for (const flow of flows) {
    if (isAuthNegativeFlowId(flow.id)) {
      kept.push(flow);
      continue;
    }
    if (isOffsiteOrOauth(flow, siteMap)) {
      dropped.push(flow.name);
      continue;
    }
    const key = clickKey(flow);
    if (key && seen.has(key)) {
      dropped.push(flow.name);
      continue;
    }
    if (key) seen.add(key);
    kept.push(flow);
  }
  return { flows: kept, dropped };
}

function clickLabels(flow: TestFlow): string[] {
  const labels: string[] = [];
  for (const step of flow.steps) {
    const match = step.action.match(/\b(?:click|press|tap)(?:ing)?\s+(?:the\s+)?["“]([^"”]+)["”]/i);
    if (match) labels.push(match[1].trim());
  }
  return labels;
}

function clickKey(flow: TestFlow): string | undefined {
  const label = clickLabels(flow)[0];
  if (!label) return undefined;
  const page = crawlPathKey(flow.startUrl) || canonicalPageUrl(flow.startUrl);
  return `${page}|${label.toLowerCase()}`;
}

function isOffsiteOrOauth(flow: TestFlow, siteMap: SiteMap): boolean {
  const labels = clickLabels(flow);
  if (labels.length === 0) return false;
  const page = siteMap.pages.find(item => sameCrawlPage(item.url, flow.startUrl));
  return labels.some(label => {
    if (OAUTH_LABEL.test(label)) return true;
    const control = page?.controls?.find(item => item.label.trim().toLowerCase() === label.toLowerCase());
    if (!control) return false;
    if (control.href && OAUTH_LABEL.test(control.href)) return true;
    if (control.href && page && !isSameCrawlSite(control.href, page.url)) return true;
    return false;
  });
}
