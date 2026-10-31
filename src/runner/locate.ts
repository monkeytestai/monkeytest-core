/**
 * Resolve a planner or runner target to one visible, enabled element.
 *
 * Models emit `label:Number Input` or a bare `number` for an unlabeled
 * `<input type="number">`. Those locators match nothing, and `locator.fill`
 * then waits out the whole step timeout. This walks a fixed fallback list
 * and returns only when exactly one element is visible and enabled.
 * Anything else is a miss, with no action timeout.
 */

import type { Locator, Page } from 'playwright';
import type { BugElement } from '../types.js';
import type { ResolvedAction } from './actions.js';

export interface LocateHit {
  locator: Locator;
  action: ResolvedAction;
  via: string;
}

export type LocateResult = LocateHit | { reason: string };

interface SnapControl {
  ref: string;
  tag: string;
  type: string;
  role: string;
  placeholder: string;
  id: string;
  inputName: string;
  preceding: string;
  heading: string;
  text: string;
  css: string;
  visible: boolean;
  enabled: boolean;
}

const GENERIC = new Set(['input', 'inputs', 'field', 'fields', 'box', 'the', 'a', 'an', 'control', 'element', 'form']);

const TYPE_ROLE: Record<string, Parameters<Page['getByRole']>[0]> = {
  number: 'spinbutton',
  text: 'textbox',
  email: 'textbox',
  password: 'textbox',
  search: 'searchbox',
  tel: 'textbox',
  url: 'textbox',
  textarea: 'textbox',
  checkbox: 'checkbox',
  radio: 'radio',
  select: 'combobox',
};

export async function locateActionTarget(page: Page, action: ResolvedAction): Promise<LocateResult> {
  if (action.tool === 'goto' || action.tool === 'noop' || action.tool === 'assert_text') {
    return { reason: 'This action has no element.' };
  }

  const { strategy, text } = queryText(action);
  const described = describe(action);
  const snap = await page.evaluate(pageFn(snapshotControls)).catch(() => [] as SnapControl[]);
  const pool = action.tool === 'fill' || action.tool === 'press'
    ? snap.filter(isField)
    : snap;
  let ambiguous = 0;

  const own = await probe(locatorFor(page, strategy, action.target || ''));
  if ('locator' in own) return { locator: own.locator, action, via: 'given' };
  if (own.count > 1) ambiguous = own.count;

  const implied = impliedType(text);
  const role = implied ? TYPE_ROLE[implied] : undefined;
  if (role && text) {
    const named = await probe(page.getByRole(role, { name: new RegExp(escapeRegex(text), 'i') }));
    if ('locator' in named) {
      return retarget(action, named.locator, 'role', `${role}:${text}`, 'role');
    }
  }
  if (text) {
    const labelled = await probe(safeLabel(page, text));
    if ('locator' in labelled) {
      return retarget(action, labelled.locator, 'label', text, 'label');
    }
    if (role) {
      const unnamed = await probe(page.getByRole(role));
      if ('locator' in unnamed) {
        const typed = pool.filter(control => control.visible && control.enabled && control.role === role);
        if (typed.length === 1 && typed[0].css) return cssHit(page, action, typed[0], 'role');
        return retarget(action, unnamed.locator, 'role', role, 'role');
      }
    }
  }

  if (text) {
    const placeholder = await probe(safePlaceholder(page, text));
    if ('locator' in placeholder) {
      return retarget(action, placeholder.locator, 'placeholder', text, 'placeholder');
    }
  }

  if (text && /^[\w.:-]+$/.test(text)) {
    const byName = await probe(page.locator(`[name="${cssAttr(text)}"]`));
    if ('locator' in byName) {
      return retarget(action, byName.locator, 'css', `[name="${cssAttr(text)}"]`, 'name');
    }
    if (/^[A-Za-z][\w-]*$/.test(text)) {
      const byId = await probe(page.locator(`#${text}`));
      if ('locator' in byId) {
        return retarget(action, byId.locator, 'css', `#${text}`, 'id');
      }
    }
  }

  if (implied) {
    const typed = pool.filter(control => control.visible && control.enabled && typeEquals(control, implied) && control.css);
    if (typed.length === 1) return cssHit(page, action, typed[0], 'type');
  }

  const wanted = tokens(text);
  if (wanted.length > 0) {
    const preceding = pool.filter(control => control.visible && control.enabled && control.css && covers(control, wanted));
    if (preceding.length === 1) return cssHit(page, action, preceding[0], 'preceding');
  }

  const refMatch = text.match(/^(?:ref[:=])?(e\d+)$/i);
  if (refMatch) {
    const ref = refMatch[1].toLowerCase();
    const control = pool.find(item => item.ref.toLowerCase() === ref && item.visible && item.enabled && item.css);
    if (control) return cssHit(page, action, control, 'ref');
  }

  const scored = bestScore(pool, wanted, implied);
  if (scored) return cssHit(page, action, scored, 'ref');

  const tried = 'role, label, placeholder, name, id, type, preceding text, and snapshot ref';
  if (ambiguous > 1) {
    return { reason: `resolved to ${ambiguous} elements for ${described}. Need exactly one visible enabled element (tried ${tried}).` };
  }
  if (implied && snap.filter(control => typeEquals(control, implied)).length === 0) {
    return { reason: `No element matched ${described}. No ${implied} control is on the page (tried ${tried}).` };
  }
  return { reason: `No element matched ${described}. Need exactly one visible enabled element (tried ${tried}).` };
}

/**
 * Read a ring for the screenshot. `boundingBox` uses a short timeout and
 * every failure is swallowed so a missing box cannot fail or stall the step.
 */
export async function captureElementRing(locator: Locator, selector?: string): Promise<BugElement | undefined> {
  const element: BugElement = {};
  const trimmed = selector?.trim();
  if (trimmed) element.selector = trimmed.slice(0, 300);
  try {
    const box = await locator.boundingBox({ timeout: 250 });
    if (box && [box.x, box.y, box.width, box.height].every(value => Number.isFinite(value))) {
      element.bounding_box = {
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
      };
    }
  } catch {
    /* The ring is optional. The step still runs. */
  }
  if (!element.selector && !element.bounding_box) return undefined;
  return element;
}

export function impliedType(text: string): string | undefined {
  const value = text.toLowerCase();
  if (/\bcheck\s*boxes?\b|\bcheckbox\b/.test(value)) return 'checkbox';
  if (/\bradio\b/.test(value)) return 'radio';
  if (/\b(e-?mail)\b/.test(value)) return 'email';
  if (/\bpassword\b/.test(value)) return 'password';
  if (/\bsearch\b/.test(value)) return 'search';
  if (/\btel\b|\bphone\b/.test(value)) return 'tel';
  if (/\bspinbutton\b|\bnumber\b|\bnumeric\b/.test(value)) return 'number';
  if (/\btextarea\b/.test(value)) return 'textarea';
  if (/\bselect\b|\bdropdown\b|\bcombobox\b/.test(value)) return 'select';
  if (/\btext\s*(input|field|box)\b|\btextbox\b/.test(value) || value === 'text') return 'text';
  return undefined;
}

function retarget(
  action: ResolvedAction,
  locator: Locator,
  strategy: ResolvedAction['locator'],
  target: string,
  via: string,
): LocateHit {
  return {
    locator,
    via,
    action: strategy && target
      ? { ...action, locator: strategy, target }
      : action,
  };
}

function cssHit(page: Page, action: ResolvedAction, control: SnapControl, via: string): LocateHit {
  return {
    locator: page.locator(control.css),
    via,
    action: {
      ...action,
      locator: 'css',
      target: control.css,
      rationale: action.rationale || `Resolved via ${via} (${control.ref}).`,
    },
  };
}

function bestScore(pool: SnapControl[], wanted: string[], implied: string | undefined): SnapControl | undefined {
  let best: SnapControl | undefined;
  let bestScore = 0;
  let tie = false;
  for (const control of pool) {
    if (!control.visible || !control.enabled || !control.css) continue;
    let score = 0;
    const hay = `${control.preceding} ${control.heading} ${control.inputName} ${control.placeholder} ${control.id} ${control.text} ${control.type}`.toLowerCase();
    for (const token of wanted) {
      if (hay.includes(token)) score += 2;
    }
    if (implied && typeEquals(control, implied)) score += 3;
    if (score <= 0) continue;
    if (score > bestScore) {
      best = control;
      bestScore = score;
      tie = false;
    } else if (score === bestScore) {
      tie = true;
    }
  }
  if (!best || tie || bestScore < 2) return undefined;
  return best;
}

function covers(control: SnapControl, wanted: string[]): boolean {
  const hay = `${control.preceding} ${control.heading} ${control.inputName} ${control.placeholder} ${control.type}`.toLowerCase();
  return wanted.every(token => hay.includes(token));
}

function typeEquals(control: SnapControl, implied: string): boolean {
  if (implied === 'text') return control.type === 'text' || control.tag === 'textarea';
  if (implied === 'textarea') return control.tag === 'textarea' || control.type === 'textarea';
  if (implied === 'select') return control.tag === 'select' || control.type === 'select';
  return control.type === implied;
}

function isField(control: SnapControl): boolean {
  return control.tag === 'input' || control.tag === 'textarea' || control.tag === 'select';
}

function tokens(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length > 1 && !GENERIC.has(token));
}

function queryText(action: ResolvedAction): { strategy: ResolvedAction['locator']; text: string } {
  let strategy = action.locator;
  let text = (action.target || '').trim();
  const embedded = text.match(/^(role|label|placeholder|text|testid)\s*:\s*(.+)$/i);
  if (embedded && (!strategy || strategy === 'css')) {
    strategy = embedded[1].toLowerCase() as ResolvedAction['locator'];
    text = embedded[2].trim();
  }
  if (strategy === 'role') {
    const roleName = text.match(/^[a-z]+\s*:\s*(.+)$/i);
    if (roleName) text = roleName[1].trim();
  }
  return { strategy, text };
}

function describe(action: ResolvedAction): string {
  if (!action.target) return '(no target)';
  const prefix = action.locator && action.locator !== 'css' ? `${action.locator}:` : '';
  const target = action.target.length > 60 ? `${action.target.slice(0, 59)}…` : action.target;
  return `${prefix}${target}`;
}

async function probe(locator: Locator | null): Promise<{ locator: Locator } | { count: number }> {
  if (!locator) return { count: 0 };
  let count = 0;
  try {
    count = await locator.count();
  } catch {
    return { count: 0 };
  }
  if (count < 1) return { count: 0 };
  const hits: number[] = [];
  const limit = Math.min(count, 8);
  for (let i = 0; i < limit; i++) {
    const ok = await locator.nth(i).evaluate(pageFn(isVisible)).catch(() => false);
    if (ok) hits.push(i);
    if (hits.length > 1) return { count: hits.length };
  }
  if (hits.length !== 1) return { count: hits.length };
  return { locator: locator.nth(hits[0]) };
}

function locatorFor(page: Page, strategy: ResolvedAction['locator'], target: string): Locator | null {
  if (!target) return null;
  try {
    switch (strategy) {
      case 'role': {
        const match = target.match(/^([a-z]+)\s*:\s*(.+)$/i);
        if (match) {
          return page.getByRole(match[1] as Parameters<Page['getByRole']>[0], {
            name: new RegExp(escapeRegex(match[2]), 'i'),
          });
        }
        return page.getByRole(target as Parameters<Page['getByRole']>[0]);
      }
      case 'text':
        return page.getByText(target, { exact: false });
      case 'placeholder':
        return page.getByPlaceholder(target);
      case 'label':
        return page.getByLabel(target);
      case 'testid':
        return page.getByTestId(target);
      case 'css':
      default:
        return page.locator(target);
    }
  } catch {
    return null;
  }
}

function safeLabel(page: Page, text: string): Locator | null {
  try { return page.getByLabel(text, { exact: false }); }
  catch { return null; }
}

function safePlaceholder(page: Page, text: string): Locator | null {
  try { return page.getByPlaceholder(text); }
  catch { return null; }
}

/**
 * esbuild's keepNames helper (`__name(...)`) is in scope in Node and missing
 * in the page. Strip it before Playwright serializes the function.
 */
export function pageFn<T extends (...args: never[]) => unknown>(fn: T): T {
  const source = fn.toString().replace(/__name\([^;]*\);/g, '');
  return (new Function(`return (${source});`) as () => T)();
}

function cssAttr(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Define esbuild's keepNames helper in the page. `tsx` injects `__name(...)`
 * into functions passed to `page.evaluate`, and that helper does not exist
 * in the browser otherwise.
 */
export async function installPageNameHelper(context: { addInitScript: (script: () => void) => Promise<unknown> }): Promise<void> {
  await context.addInitScript(() => {
    const root = globalThis as unknown as { __name?: (target: unknown) => unknown };
    root.__name = (target: unknown) => target;
  });
}

/** Runs in the page. Must not close over Node state. Disabled controls stay visible so a strict oracle can report them. */
function isVisible(el: Element): boolean {
  const html = el as HTMLElement;
  const style = window.getComputedStyle(html);
  const rect = html.getBoundingClientRect();
  if (style.visibility === 'hidden' || style.display === 'none' || html.hidden) return false;
  if (rect.width < 1 || rect.height < 1) return false;
  return true;
}

/** Runs in the page. Assigns snapshot refs in DOM order. */
function snapshotControls(): SnapControl[] {
  function txt(el: Element): string {
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function roleOf(el: Element): string {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.toLowerCase();
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'button' || type === 'submit' || type === 'image') return 'button';
      if (type === 'number' || type === 'range') return 'spinbutton';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    return '';
  }

  function cssFor(el: Element): string {
    const html = el as HTMLElement;
    if (html.id) return `#${CSS.escape(html.id)}`;
    const testId = html.getAttribute('data-testid');
    if (testId) {
      const sel = `[data-testid="${CSS.escape(testId)}"]`;
      if (document.querySelectorAll(sel).length === 1) return sel;
    }
    const name = html.getAttribute('name');
    const tag = html.tagName.toLowerCase();
    if (name) {
      const sel = `${tag}[name="${CSS.escape(name)}"]`;
      if (document.querySelectorAll(sel).length === 1) return sel;
    }
    const type = (html.getAttribute('type') || '').toLowerCase();
    if (type && tag === 'input') {
      const sel = `input[type="${CSS.escape(type)}"]`;
      if (document.querySelectorAll(sel).length === 1) return sel;
    }
    const parts: string[] = [];
    let node: Element | null = html;
    let depth = 0;
    while (node && node.tagName.toLowerCase() !== 'html' && depth < 5) {
      const current = node.tagName.toLowerCase();
      const parent: HTMLElement | null = node.parentElement;
      if (!parent) break;
      const siblings = Array.from(parent.children).filter((child: Element) => child.tagName === node!.tagName);
      const index = siblings.indexOf(node) + 1;
      parts.unshift(siblings.length > 1 ? `${current}:nth-of-type(${index})` : current);
      node = parent;
      depth += 1;
    }
    return parts.join(' > ');
  }

  function context(el: Element): { preceding: string; heading: string } {
    const chunks: string[] = [];
    let node = el.previousElementSibling;
    let hops = 0;
    while (node && hops < 4) {
      const text = txt(node);
      if (text) chunks.unshift(text.slice(0, 80));
      node = node.previousElementSibling;
      hops += 1;
    }
    let heading = '';
    let parent: Element | null = el.parentElement;
    let depth = 0;
    while (parent && depth < 6 && !heading) {
      let sib = parent.previousElementSibling;
      let sibHops = 0;
      while (sib && sibHops < 4 && !heading) {
        if (/^h[1-6]$/i.test(sib.tagName)) heading = txt(sib).slice(0, 80);
        sib = sib.previousElementSibling;
        sibHops += 1;
      }
      parent = parent.parentElement;
      depth += 1;
    }
    return {
      preceding: chunks.join(' ').replace(/\s+/g, ' ').trim().slice(0, 80),
      heading,
    };
  }

  function visibleInPage(el: Element): boolean {
    const html = el as HTMLElement;
    const style = window.getComputedStyle(html);
    const rect = html.getBoundingClientRect();
    if (style.visibility === 'hidden' || style.display === 'none' || html.hidden) return false;
    if (rect.width < 1 || rect.height < 1) return false;
    return true;
  }

  const controls: SnapControl[] = [];
  let ref = 0;
  const nodes = Array.from(document.querySelectorAll('input, textarea, select, button, a[href], [role="button"]'));
  for (const el of nodes) {
    const tag = el.tagName.toLowerCase();
    const type = (tag === 'input' ? ((el as HTMLInputElement).type || 'text') : tag).toLowerCase();
    if (type === 'hidden') continue;
    ref += 1;
    const ctx = context(el);
    const html = el as HTMLInputElement;
    controls.push({
      ref: `e${ref}`,
      tag,
      type,
      role: roleOf(el),
      placeholder: html.placeholder || '',
      id: html.id || '',
      inputName: html.name || '',
      preceding: ctx.preceding,
      heading: ctx.heading,
      text: txt(el).slice(0, 80),
      css: cssFor(el),
      visible: visibleInPage(el),
      enabled: !html.disabled && el.getAttribute('aria-disabled') !== 'true',
    });
    if (controls.length >= 40) break;
  }
  return controls;
}
