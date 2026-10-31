/**
 * Drop or repair planner flows that name a control the crawl did not see.
 *
 * A model will invent a checkbox flow and a text-input flow for a page whose
 * only control is an unlabeled number input. Those flows used to run, time
 * out in `locator.fill`, and come back inconclusive. They are not tests.
 * Flows the engine built from scraped forms and controls are left alone;
 * callers pass only the model list.
 */

import type { SiteMap, SiteMapFormInput, SiteMapPage, TestFlow, TestStep } from '../types.js';
import { sameCrawlPage } from '../explorer/queue.js';

export interface DroppedFlow {
  id: string;
  name: string;
  reason: string;
}

export interface ReconciledFlows {
  flows: TestFlow[];
  dropped: DroppedFlow[];
  /** One sentence for the plan notes. Empty when nothing changed. */
  note?: string;
}

const GENERIC = new Set(['input', 'inputs', 'field', 'fields', 'box', 'the', 'a', 'an', 'control', 'element', 'form']);

export function reconcileModelFlows(flows: TestFlow[], siteMap: SiteMap): ReconciledFlows {
  const kept: TestFlow[] = [];
  const dropped: DroppedFlow[] = [];
  const repairs: string[] = [];

  for (const flow of flows) {
    const page = siteMap.pages.find(item => sameCrawlPage(item.url, flow.startUrl));
    if (!page) {
      dropped.push({
        id: flow.id,
        name: flow.name,
        reason: 'start URL was not crawled',
      });
      continue;
    }
    const fields = fieldsOf(page);
    if (fields.length === 0) {
      kept.push(flow);
      continue;
    }

    const purpose = requestedKind(`${flow.name}\n${flow.description}`);
    if (purpose && !kindExists(fields, purpose)) {
      dropped.push({
        id: flow.id,
        name: flow.name,
        reason: missingReason(purpose),
      });
      continue;
    }

    const steps: TestStep[] = [];
    let repaired = false;
    let stepDrop = '';
    for (const step of flow.steps) {
      const judged = judgeStep(step, fields, page);
      if (judged.drop) {
        stepDrop = judged.drop;
        continue;
      }
      if (judged.step.action !== step.action) repaired = true;
      steps.push(judged.step);
    }

    if (steps.length === 0) {
      dropped.push({
        id: flow.id,
        name: flow.name,
        reason: stepDrop || 'no matching control',
      });
      continue;
    }

    const next = repaired ? { ...flow, steps } : flow;
    if (repaired) repairs.push(flow.name);
    kept.push(next);
  }

  const sentences = [
    dropped.length
      ? `Dropped ${dropped.length} flow${dropped.length === 1 ? '' : 's'} that named controls the page does not have: ${dropped.map(item => `"${item.name}" (${item.reason})`).join(', ')}.`
      : '',
    repairs.length
      ? `Repaired ${repairs.map(name => `"${name}"`).join(', ')} to target a control the crawl actually saw.`
      : '',
  ].filter(Boolean);

  return {
    flows: kept,
    dropped,
    ...(sentences.length ? { note: sentences.join(' ') } : {}),
  };
}

function fieldsOf(page: SiteMapPage): SiteMapFormInput[] {
  if (page.inputs && page.inputs.length > 0) return page.inputs;
  const fromForms: SiteMapFormInput[] = [];
  for (const form of page.forms ?? []) {
    if (form.inputs && form.inputs.length > 0) fromForms.push(...form.inputs);
    else fromForms.push(...form.fields.filter(Boolean).map(token => ({ name: token })));
  }
  return fromForms;
}

function judgeStep(
  step: TestStep,
  fields: SiteMapFormInput[],
  page: SiteMapPage,
): { step: TestStep; drop?: string } {
  const action = step.action;
  const kind = requestedKind(action);
  if (kind && !kindExists(fields, kind)) {
    return { step, drop: missingReason(kind) };
  }

  const quoted = action.match(/\bfill(?:\s+in)?\s+the\s+["“]([^"”]+)["”]/i)?.[1]?.trim();
  if (quoted && !matchesAny(fields, quoted) && !(kind && kindExists(fields, kind) && fields.filter(field => fieldMatchesKind(field, kind)).length === 1)) {
    const fuzzy = uniqueFuzzy(fields, quoted);
    if (!fuzzy) return { step, drop: `no control matching "${quoted}"` };
  }

  const click = action.match(/\bclick(?:ing)?\s+(?:the\s+)?["“]([^"”]+)["”]/i)?.[1]?.trim();
  if (click && page.controls && page.controls.length > 0) {
    const known = page.controls.some(control => control.label.trim().toLowerCase() === click.toLowerCase());
    if (!known && !matchesAny(fields, click)) {
      return { step, drop: `no control matching "${click}"` };
    }
  }

  const repaired = repairFill(step, fields);
  return { step: repaired ?? step };
}

function repairFill(step: TestStep, fields: SiteMapFormInput[]): TestStep | undefined {
  const kind = requestedKind(`${step.action}`);
  const quoted = step.action.match(/\bfill(?:\s+in)?\s+the\s+["“]([^"”]+)["”]/i)?.[1]?.trim();
  const quotedKind = quoted ? requestedKind(quoted) : undefined;
  const wantsNumber = kind === 'number' || quotedKind === 'number';
  if (!wantsNumber && !/\bfill\b|\btype\b|\benter\b/i.test(step.action)) return undefined;
  const numbers = fields.filter(field => fieldMatchesKind(field, 'number'));
  if (numbers.length !== 1) return undefined;
  if (!wantsNumber && quoted && matchesAny(fields, quoted)) return undefined;
  if (!wantsNumber) return undefined;
  const action = fillAction(numbers[0]);
  if (action === step.action) return undefined;
  return { ...step, action };
}

function fillAction(field: SiteMapFormInput): string {
  const type = (field.type || '').toLowerCase();
  const hint = type === 'number' ? ' (input[type=number])' : '';
  const label = clean(field.preceding || field.label || field.name || '');
  if (label) return `Fill the "${label}" field${hint}`;
  if (type) return `Fill the ${type} input${hint}`;
  return 'Fill the input';
}

function matchesAny(fields: SiteMapFormInput[], wanted: string): boolean {
  return fields.some(field => exactField(field, wanted));
}

function uniqueFuzzy(fields: SiteMapFormInput[], wanted: string): SiteMapFormInput | undefined {
  const hits = fields.filter(field => fuzzyField(field, wanted));
  return hits.length === 1 ? hits[0] : undefined;
}

function exactField(field: SiteMapFormInput, wanted: string): boolean {
  const needle = wanted.trim().toLowerCase();
  return [field.label, field.name, field.placeholder, field.id, field.preceding]
    .some(value => Boolean(value && value.trim().toLowerCase() === needle));
}

function fuzzyField(field: SiteMapFormInput, wanted: string): boolean {
  if (exactField(field, wanted)) return true;
  const kind = requestedKind(wanted);
  if (kind && fieldMatchesKind(field, kind)) return true;
  const wantedTokens = tokens(wanted);
  if (wantedTokens.length === 0) return false;
  const hay = `${field.label || ''} ${field.name || ''} ${field.placeholder || ''} ${field.preceding || ''} ${field.heading || ''} ${field.type || ''}`.toLowerCase();
  return wantedTokens.every(token => hay.includes(token));
}

function kindExists(fields: SiteMapFormInput[], kind: string): boolean {
  return fields.some(field => fieldMatchesKind(field, kind));
}

function fieldMatchesKind(field: SiteMapFormInput, kind: string): boolean {
  const type = (field.type || '').toLowerCase();
  const name = (field.name || '').toLowerCase();
  if (kind === 'text') {
    if (type === 'number' || type === 'checkbox' || type === 'radio' || type === 'range' || type === 'hidden') return false;
    if (!type) return true;
    return ['text', 'email', 'password', 'search', 'tel', 'url', 'textarea'].includes(type);
  }
  if (kind === 'number') return type === 'number' || type === 'range' || name === 'number';
  if (kind === 'checkbox') return type === 'checkbox' || name === 'checkbox';
  if (kind === 'radio') return type === 'radio' || name === 'radio';
  return type === kind || name === kind;
}

function requestedKind(text: string): string | undefined {
  const value = text.toLowerCase();
  if (/\bcheck\s*boxes?\b|\bcheckbox\b/.test(value)) return 'checkbox';
  if (/\bradio(?:\s+button)?s?\b/.test(value)) return 'radio';
  if (/\btext\s*(input|field|box)\b|\btextbox\b/.test(value)) return 'text';
  if (/\bnumber\s*input\b|\bnumeric\s*input\b|\bspinbutton\b/.test(value)) return 'number';
  return undefined;
}

function missingReason(kind: string): string {
  if (kind === 'text') return 'no text input';
  return `no ${kind}`;
}

function tokens(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length > 1 && !GENERIC.has(token));
}

function clean(value: string): string {
  return value.replace(/\s+/g, ' ').trim().replace(/["“”]/g, "'").slice(0, 80);
}
