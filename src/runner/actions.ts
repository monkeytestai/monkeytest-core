/**
 * Translate a plan step into a Playwright action, execute it, and capture a
 * stable locator (role, name, text, test id, CSS fallback) for later replay.
 */

import type { Locator, Page } from 'playwright';
import { z } from 'zod';
import type { LLM } from '../llm/index.js';
import type {
  TestFlow,
  TestStep,
  StepStatus,
  TraceLocator,
  TraceLocatorStrategy,
} from '../types.js';

export const ActionSchema = z.object({
  tool: z.enum(['click', 'fill', 'goto', 'wait', 'assert_text', 'press', 'noop']),
  /** CSS selector, URL (for goto), test id, or text snippet (for assert_text). */
  target: z.string().optional(),
  /** Value to type (for fill) or key chord (for press). */
  value: z.string().optional(),
  /**
   * Locator strategy hint. Role / text / label / testid survive DOM reshuffles
   * better than a raw CSS selector.
   */
  locator: z.enum(['css', 'role', 'text', 'placeholder', 'label', 'testid']).optional(),
  /** One-sentence explanation, useful for the report timeline. */
  rationale: z.string().optional(),
});

export type ResolvedAction = z.infer<typeof ActionSchema>;

export interface PageSkeletonForLLM {
  url: string;
  title: string;
  headings: string[];
  buttons: string[];
  links: { text: string; href: string }[];
  inputs: { label?: string; placeholder?: string; name?: string; type?: string }[];
}

export async function resolveAction(
  llm: LLM,
  flow: TestFlow,
  step: TestStep,
  skeleton: PageSkeletonForLLM,
): Promise<ResolvedAction> {

  const prompt = `
You are translating a single natural-language test step into a concrete browser
action that a Playwright agent can execute.

You MUST reply with a JSON object, no prose, no markdown.

Schema:
  tool:     "click" | "fill" | "goto" | "wait" | "assert_text" | "press" | "noop"
  target:   string                — CSS selector, role-like description, or URL/text (see examples)
  value:    string (optional)     — value to type for "fill", or key for "press" (e.g. "Enter")
  locator:  "css" | "role" | "text" | "placeholder" | "label" | "testid" (optional, default "css")
  rationale: string (optional)    — one short sentence explaining your choice

Tool semantics:
  click         — click the element identified by target+locator
  fill          — type \`value\` into the element identified by target+locator
  goto          — navigate to URL in target
  wait          — wait for selector in target to appear (use sparingly)
  assert_text   — observe whether the page contains the text in target. Missing text is not a bug by itself.
  press         — press a key (target = optional selector, value = key like "Enter")
  noop          — only use this when the step is impossible (e.g. asks for real signup)

Locator guidance:
  - Prefer "testid", "role", "label", "placeholder", or "text" when CSS selectors aren't obvious.
  - For testid: target is the data-testid value.
  - For role: target like "button:Sign in" or "link:Pricing" or "textbox:Email".
  - For text: target is the visible text.
  - For label: target is the form label text.
  - For placeholder: target is the input placeholder text.
  - If the control is not in the skeleton, use "noop" rather than guessing a selector.
  - Never invent selectors, search boxes, or exact page titles. Use only elements visible in the skeleton.
  - Do not turn page-title expectations into bugs; exploratory users observe what loaded.
  - If the step asks to log in, enter OTP, or create an account, use "noop".

Context:
  Flow:           ${flow.name} (${flow.kind})
  Flow goal:      ${flow.expectation}
  Step:           ${step.action}
  Expectation:    ${step.expectation || '(none stated)'}
  Current URL:    ${skeleton.url}
  Page title:     ${skeleton.title}

Visible page skeleton (top of body):
  Headings: ${skeleton.headings.slice(0, 8).join(' | ') || '(none)'}
  Buttons:  ${skeleton.buttons.slice(0, 12).join(' | ') || '(none)'}
  Links:    ${skeleton.links.slice(0, 12).map(l => l.text).join(' | ') || '(none)'}
  Inputs:   ${skeleton.inputs.slice(0, 12).map(i => `${i.label || i.placeholder || i.name || i.type}`).join(' | ') || '(none)'}

Reply with JSON only.`;

  return llm.generateJSON({
    label: 'runner.resolveAction',
    prompt,
    schema: ActionSchema,
  });

}

export interface ActionOutcome {
  status: StepStatus;
  observation: string;
  error?: string;
}

export async function executeAction(page: Page, action: ResolvedAction, timeoutMs: number): Promise<ActionOutcome> {

  try {

    switch (action.tool){

      case 'click': {
        const locator = buildLocator(page, action);
        const disabled = await failIfDisabled(locator, action);
        if (disabled) return disabled;
        await locator.first().click({ timeout: timeoutMs });
        await settleSPA(page).catch(() => {});
        return { status: 'passed', observation: `Clicked ${describeTarget(action)}.` };
      }

      case 'fill': {
        const locator = buildLocator(page, action);
        await locator.first().fill(action.value ?? '', { timeout: timeoutMs });
        return { status: 'passed', observation: `Typed "${truncate(action.value ?? '', 40)}" into ${describeTarget(action)}.` };
      }

      case 'goto': {
        const url = action.target || '';
        if (!/^https?:\/\//.test(url)){
          return { status: 'failed', observation: `Refused to navigate to non-http URL "${url}".`, error: 'invalid_url' };
        }
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        await settleSPA(page).catch(() => {});
        return { status: 'passed', observation: `Navigated to ${url}.` };
      }

      case 'wait': {
        const locator = buildLocator(page, action);
        await locator.first().waitFor({ state: 'visible', timeout: timeoutMs });
        return { status: 'passed', observation: `Confirmed ${describeTarget(action)} is visible.` };
      }

      case 'assert_text': {
        const text = action.target || '';
        if (!text) return { status: 'skipped', observation: 'No text supplied for observation.' };
        const found = await page.locator('body').filter({ hasText: text }).first().count();
        if (found > 0){
          return { status: 'passed', observation: `Observed "${truncate(text, 60)}" on the page.` };
        }
        return {
          status: 'skipped',
          observation: `Did not observe "${truncate(text, 60)}" on the page. Treated as an exploratory observation, not a product bug.`,
        };
      }

      case 'press': {
        const key = action.value || 'Enter';
        if (action.target){
          const locator = buildLocator(page, action);
          const disabled = await failIfDisabled(locator, action);
          if (disabled) return disabled;
          await locator.first().press(key, { timeout: timeoutMs });
        } else {
          await page.keyboard.press(key);
        }
        await settleSPA(page).catch(() => {});
        return { status: 'passed', observation: `Pressed ${key}${action.target ? ` on ${describeTarget(action)}` : ''}.` };
      }

      case 'noop': {
        return {
          status: 'skipped',
          observation: action.rationale || 'Step intentionally skipped — not safe to automate.',
        };
      }

    }

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isSoftAutomationMiss(msg)){
      return {
        status: 'skipped',
        observation: `${capitalise(action.tool)} on ${describeTarget(action)} could not be completed by the agent (${truncate(msg, 140)}). Treated as inconclusive rather than a product bug.`,
      };
    }
    return {
      status: 'failed',
      observation: `${capitalise(action.tool)} on ${describeTarget(action)} failed: ${truncate(msg, 160)}`,
      error: msg,
    };
  }

  return { status: 'skipped', observation: 'Unknown tool — skipped.' };

}

export function buildLocator(page: Page, action: ResolvedAction): Locator {
  const target = action.target || '';
  const strategy = action.locator || 'css';

  switch (strategy){
    case 'role': {
      // target is "role:label" e.g. "button:Sign in"
      const m = target.match(/^([a-z]+)\s*:\s*(.+)$/i);
      if (m){
        return page.getByRole(m[1] as Parameters<Page['getByRole']>[0], { name: new RegExp(escapeRegex(m[2]), 'i') });
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

}

/**
 * Read role / accessible name / text / test id / CSS off the element the
 * action is about to hit. Replay tries these in stability order and does not
 * need the original LLM call.
 */
export async function captureLocator(page: Page, action: ResolvedAction): Promise<TraceLocator> {
  const strategy = (action.locator || 'css') as TraceLocatorStrategy;
  const base: TraceLocator = {
    strategy,
    target: action.target || '',
  };

  if (strategy === 'role'){
    const m = (action.target || '').match(/^([a-z]+)\s*:\s*(.+)$/i);
    if (m){
      base.role = m[1].toLowerCase();
      base.name = m[2].trim();
    }
  } else if (strategy === 'text'){
    base.text = action.target;
  } else if (strategy === 'label'){
    base.label = action.target;
    base.name = action.target;
  } else if (strategy === 'placeholder'){
    base.placeholder = action.target;
    base.name = action.target;
  } else if (strategy === 'testid'){
    base.testId = action.target;
  } else if (strategy === 'css'){
    base.css = action.target;
  }

  if (action.tool === 'goto' || action.tool === 'noop' || action.tool === 'assert_text'){
    return base;
  }
  if (!action.target) return base;

  try {
    const locator = buildLocator(page, action);
    const count = await locator.count();
    if (count === 0) return base;
    const info = await locator.first().evaluate(readElementIdentity);
    return {
      ...base,
      ...(info.role ? { role: info.role } : {}),
      ...(info.name ? { name: info.name } : {}),
      ...(info.text ? { text: info.text } : {}),
      ...(info.testId ? { testId: info.testId } : {}),
      ...(info.css ? { css: info.css } : {}),
      ...(info.placeholder ? { placeholder: info.placeholder } : {}),
      ...(info.label ? { label: info.label } : {}),
    };
  } catch {
    return base;
  }
}

export async function skeletonForLLM(page: Page): Promise<PageSkeletonForLLM> {

  const url = page.url();
  const title = await page.title().catch(() => '');

  const collected = await page.evaluate(() => {

    function txt(el: Element): string {
      return (el.textContent || '').trim().replace(/\s+/g, ' ');
    }

    const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
      .map(txt).filter(Boolean).slice(0, 12);

    const buttons = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'))
      .map(b => txt(b) || (b as HTMLInputElement).value || '')
      .filter(Boolean).slice(0, 25);

    const links = Array.from(document.querySelectorAll('a[href]'))
      .slice(0, 25)
      .map(a => ({
        text: txt(a),
        href: (a as HTMLAnchorElement).href,
      }))
      .filter(l => l.text);

    const inputs = Array.from(document.querySelectorAll('input, textarea, select'))
      .slice(0, 25)
      .map(el => {
        const i = el as HTMLInputElement;
        const labelEl = i.id ? document.querySelector(`label[for="${CSS.escape(i.id)}"]`) : null;
        return {
          label: labelEl ? txt(labelEl) : undefined,
          placeholder: i.placeholder || undefined,
          name: i.name || undefined,
          type: i.type || i.tagName.toLowerCase(),
        };
      });

    return { headings, buttons, links, inputs };

  });

  return {
    url,
    title,
    ...collected,
  };

}

export async function settleSPA(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => {});
  await page.waitForFunction(
    () => (document.body?.innerText || '').replace(/\s+/g, '').length > 30,
    undefined,
    { timeout: 6_000 },
  ).catch(() => {});
}

export function describeTarget(action: ResolvedAction): string {
  if (!action.target) return '(no target)';
  const prefix = action.locator && action.locator !== 'css' ? `${action.locator}:` : '';
  return `${prefix}${truncate(action.target, 60)}`;
}

/**
 * A disabled control is a product bug. Playwright would otherwise wait until
 * the control becomes enabled and the runner would record a soft timeout skip.
 * A missing element throws immediately (`isDisabled` defaults to no wait) and
 * falls through to the real action.
 */
async function failIfDisabled(locator: Locator, action: ResolvedAction): Promise<ActionOutcome | undefined> {
  try {
    if (await locator.first().isDisabled()) {
      return {
        status: 'failed',
        observation: `${capitalise(action.tool)} on ${describeTarget(action)} failed: control is disabled.`,
        error: 'element-disabled',
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function isSoftAutomationMiss(msg: string): boolean {
  const lower = msg.toLowerCase();
  return lower.includes('timeout') && (
    lower.includes('waiting for locator')
    || lower.includes('locator.fill')
    || lower.includes('locator.click')
    || lower.includes('locator.press')
    || lower.includes('locator.waitfor')
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function capitalise(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface ElementIdentity {
  role?: string;
  name?: string;
  text?: string;
  testId?: string;
  css?: string;
  placeholder?: string;
  label?: string;
}

/**
 * Runs in the page. Kept as a function declaration so Playwright can serialize
 * it into `locator.evaluate` without closing over Node state.
 */
function readElementIdentity(el: Element): ElementIdentity {
  function clean(value: string | null | undefined): string | undefined {
    const text = (value || '').replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, 160) : undefined;
  }

  function implicitRole(node: Element): string | undefined {
    const explicit = node.getAttribute('role');
    if (explicit) return explicit.toLowerCase();
    const tag = node.tagName.toLowerCase();
    if (tag === 'a' && node.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'input'){
      const type = (node.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'button' || type === 'submit' || type === 'image') return 'button';
      if (['email', 'password', 'search', 'tel', 'url', 'text', 'number', ''].includes(type)) return 'textbox';
    }
    return undefined;
  }

  const html = el as HTMLElement;
  const testId = html.getAttribute('data-testid') || undefined;
  const placeholder = html.getAttribute('placeholder') || undefined;
  const text = clean(html.innerText || html.textContent);
  let label: string | undefined;
  const id = html.getAttribute('id');
  if (id){
    const labelEl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
    label = clean(labelEl?.textContent);
  }
  if (!label){
    const wrapped = html.closest('label');
    if (wrapped && wrapped !== html) label = clean(wrapped.textContent);
  }

  let name = clean(html.getAttribute('aria-label')) || label || clean(placeholder) || text;
  const labelledBy = html.getAttribute('aria-labelledby');
  if (labelledBy){
    const combined = labelledBy.split(/\s+/)
      .map(part => document.getElementById(part)?.textContent || '')
      .join(' ');
    name = clean(combined) || name;
  }

  let css: string | undefined;
  if (testId) css = `[data-testid="${CSS.escape(testId)}"]`;
  else if (id) css = `#${CSS.escape(id)}`;
  else {
    const parts: string[] = [];
    let node: Element | null = html;
    let depth = 0;
    while (node && node.tagName.toLowerCase() !== 'html' && depth < 4){
      const tag = node.tagName.toLowerCase();
      const parentEl: HTMLElement | null = node.parentElement;
      if (!parentEl) break;
      const siblings = Array.from(parentEl.children).filter(child => child.tagName === node!.tagName);
      const index = siblings.indexOf(node) + 1;
      parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${index})` : tag);
      node = parentEl;
      depth++;
    }
    css = parts.join(' > ') || undefined;
  }

  return {
    role: implicitRole(html),
    name,
    text,
    testId,
    css,
    placeholder: placeholder || undefined,
    label,
  };
}
