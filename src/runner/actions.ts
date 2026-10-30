/**
 * Translate a plan step into a Playwright action, execute it, and capture a
 * stable locator (role, name, text, test id, CSS fallback) for later replay.
 */

import type { Locator, Page } from 'playwright';
import { z } from 'zod';
import { clipText, coerceEnum, coerceToString, unwrapModelObject } from '../llm/coerce.js';
import type { LLM } from '../llm/index.js';
import type {
  TestFlow,
  TestStep,
  StepStatus,
  TraceLocator,
  TraceLocatorStrategy,
} from '../types.js';
import { isAutomationFault } from '../automation/signatures.js';

const ACTION_TOOLS = ['click', 'fill', 'goto', 'wait', 'assert_text', 'press', 'noop'] as const;
const ACTION_LOCATORS = ['css', 'role', 'text', 'placeholder', 'label', 'testid'] as const;

const TOOL_ALIASES: Record<string, typeof ACTION_TOOLS[number]> = {
  type: 'fill',
  input: 'fill',
  fill_in: 'fill',
  navigate: 'goto',
  open: 'goto',
  visit: 'goto',
  assert: 'assert_text',
  asserttext: 'assert_text',
  check_text: 'assert_text',
  keypress: 'press',
  key: 'press',
  none: 'noop',
  skip: 'noop',
  tap: 'click',
  wait_for: 'wait',
};

const LOCATOR_ALIASES: Record<string, typeof ACTION_LOCATORS[number]> = {
  css_selector: 'css',
  selector: 'css',
  visible_text: 'text',
  test_id: 'testid',
  data_testid: 'testid',
  aria_label: 'label',
};

function coerceActionInput(value: unknown): unknown {
  const unwrapped = unwrapModelObject(value, ['tool', 'action', 'target', 'selector']);
  if (!unwrapped || typeof unwrapped !== 'object' || Array.isArray(unwrapped)) return unwrapped;
  const record = unwrapped as Record<string, unknown>;
  const tool = coerceEnum(record.tool ?? record.action, ACTION_TOOLS, TOOL_ALIASES);
  const locator = coerceEnum(record.locator ?? record.strategy, ACTION_LOCATORS, LOCATOR_ALIASES);
  const target = coerceToString(record.target ?? record.selector ?? record.url ?? record.element);
  const filled = coerceToString(record.value ?? record.input ?? record.key);
  const rationale = coerceToString(record.rationale ?? record.reason);
  return {
    ...(tool ? { tool } : {}),
    ...(locator ? { locator } : {}),
    ...(target ? { target } : {}),
    ...(filled !== undefined ? { value: filled } : {}),
    ...(rationale ? { rationale: clipText(rationale, 400) } : {}),
  };
}

export const ActionSchema = z.preprocess(coerceActionInput, z.object({
  tool: z.enum(ACTION_TOOLS),
  /** CSS selector, URL (for goto), test id, or text snippet (for assert_text). */
  target: z.string().optional(),
  /** Value to type (for fill) or key chord (for press). */
  value: z.string().optional(),
  /**
   * Locator strategy hint. Role / text / label / testid survive DOM reshuffles
   * better than a raw CSS selector.
   */
  locator: z.enum(ACTION_LOCATORS).optional(),
  /** One-sentence explanation, useful for the report timeline. */
  rationale: z.string().optional(),
}));

export type ResolvedAction = z.infer<typeof ActionSchema>;

export interface PageSkeletonForLLM {
  url: string;
  title: string;
  headings: string[];
  buttons: string[];
  links: { text: string; href: string }[];
  inputs: { label?: string; placeholder?: string; name?: string; type?: string }[];
}

/**
 * Execute a step whose wording names a control that is already on screen.
 *
 * `Click "Save order"` and `Fill the "email" field` do not need a model.
 * A step that does not quote a visible label returns null and the caller
 * falls through to `resolveAction`.
 */
export function directActionFromStep(
  action: string,
  skeleton: PageSkeletonForLLM,
): ResolvedAction | null {
  const fill = action.match(/\bfill(?:\s+in)?\s+the\s+["“]([^"”]+)["”]\s+field/i);
  if (fill) {
    const field = fill[1].trim();
    const nameHint = action.match(/\bname\s*=\s*["“']([^"”']+)["”']/i)?.[1]?.trim();
    const input = (nameHint && findInput(skeleton.inputs, nameHint)) || findInput(skeleton.inputs, field);
    if (!input) return null;
    return fillActionForInput(input, undefined, `Field "${field}" is on the page.`);
  }

  const quoted = action.match(/(?:click|press|tap)(?:ing)?\s+(?:the\s+)?["“]([^"”]+)["”]/i);
  const plain = action.match(/^(?:please\s+)?(?:click|press|tap)\s+(?:the\s+)?(.+?)(?:\s+(?:button|link))?[.!]?\s*$/i);
  const label = (quoted?.[1] || (plain && matchesControl(skeleton, plain[1].trim()) ? plain[1].trim() : '')).trim();
  if (!label) return null;

  const wantsLink = /\blink\b/i.test(action) && !/\bbutton\b/i.test(action);
  const button = findText(skeleton.buttons, label);
  const link = skeleton.links.find(item => item.text.trim().toLowerCase() === label.toLowerCase());
  if (wantsLink && link) {
    return clickAction('link', link.text);
  }
  if (button && !wantsLink) return clickAction('button', button);
  if (link) return clickAction('link', link.text);
  if (button) return clickAction('button', button);
  return null;
}

function clickAction(role: 'button' | 'link', label: string): ResolvedAction {
  return {
    tool: 'click',
    locator: 'role',
    target: `${role}:${label}`,
    rationale: `${role} "${label}" is on the page.`,
  };
}

function matchesControl(skeleton: PageSkeletonForLLM, label: string): boolean {
  return Boolean(findText(skeleton.buttons, label) || skeleton.links.some(link => link.text.trim().toLowerCase() === label.toLowerCase()));
}

function findText(values: string[], label: string): string | undefined {
  const needle = label.trim().toLowerCase();
  return values.find(value => value.trim().toLowerCase() === needle);
}

/**
 * A model often answers `placeholder:Email` for a box whose only identity is
 * its label or `name`. Prefer those. Placeholder remains when it is all the
 * page exposed.
 */
export function groundFillAction(
  action: ResolvedAction,
  skeleton: PageSkeletonForLLM,
): ResolvedAction {
  if (action.tool !== 'fill') return action;
  if (action.locator === 'role' || action.locator === 'testid') return action;
  const wanted = (action.target || '').trim();
  if (!wanted) return action;
  if (action.locator === 'css' && (inputByNameSelector(skeleton.inputs, wanted) || /[[\]#.=]/.test(wanted))) {
    const known = inputByNameSelector(skeleton.inputs, wanted);
    if (!known) return action;
    const value = valueForInput(known, action.value);
    return action.value === value ? action : { ...action, value };
  }

  const placeholderOnly = action.locator === 'placeholder'
    ? findInput(skeleton.inputs, wanted, 'placeholder')
    : undefined;
  if (placeholderOnly && !placeholderOnly.label && !placeholderOnly.name) {
    const value = valueForInput(placeholderOnly, action.value);
    return value === action.value ? action : { ...action, value };
  }

  const input = placeholderOnly || findInput(skeleton.inputs, wanted);
  if (!input || (!input.label && !input.name)) return action;

  const grounded = fillActionForInput(input, action.value, action.rationale);
  const withValue = action.value === grounded.value ? action : { ...action, value: grounded.value };
  if (action.locator === grounded.locator && action.target === grounded.target) return withValue;
  const inventedPlaceholder = action.locator === 'placeholder';
  const labelMiss = action.locator === 'label' && !(input.label && sameField(input.label, wanted) && action.target === input.label);
  const bareCss = !action.locator || (action.locator === 'css' && !/[[\]#.=]/.test(wanted));
  if (!inventedPlaceholder && !labelMiss && !bareCss) return withValue;
  return {
    ...withValue,
    locator: grounded.locator,
    target: grounded.target,
    rationale: grounded.rationale,
  };
}

function fillActionForInput(
  input: PageSkeletonForLLM['inputs'][number],
  value: string | undefined,
  rationale?: string,
): ResolvedAction {
  const sample = valueForInput(input, value);
  if (input.label) {
    return {
      tool: 'fill',
      locator: 'label',
      target: input.label,
      value: sample,
      rationale: rationale || `Label "${input.label}" is on the page.`,
    };
  }
  if (input.name) {
    return {
      tool: 'fill',
      locator: 'css',
      target: nameSelector(input.name),
      value: sample,
      rationale: rationale || `Input name "${input.name}" is on the page.`,
    };
  }
  return {
    tool: 'fill',
    locator: 'placeholder',
    target: input.placeholder || '',
    value: sample,
    rationale: rationale || `Placeholder "${input.placeholder}" is on the page.`,
  };
}

function findInput(
  inputs: PageSkeletonForLLM['inputs'],
  wanted: string,
  only?: 'label' | 'name' | 'placeholder',
): PageSkeletonForLLM['inputs'][number] | undefined {
  const keys = only ? [only] : (['name', 'label', 'placeholder'] as const);
  return inputs.find(input => keys.some(key => sameField(input[key], wanted)));
}

function inputByNameSelector(
  inputs: PageSkeletonForLLM['inputs'],
  target: string,
): PageSkeletonForLLM['inputs'][number] | undefined {
  return inputs.find(input => input.name && nameSelector(input.name) === target);
}

function sameField(value: string | undefined, wanted: string): boolean {
  return Boolean(value && value.trim().toLowerCase() === wanted.trim().toLowerCase());
}

function nameSelector(name: string): string {
  return `[name="${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
}

function sampleFieldValue(input: { label?: string; placeholder?: string; name?: string; type?: string }): string {
  return valueForInput(input);
}

/**
 * A value Playwright can type into this control.
 *
 * `input[type=number]` and `tel` always get digits. `555-0100` is not a
 * number, and Playwright throws "Cannot type text into input" if it is
 * typed into a number field. A caller-supplied value is kept when it
 * already matches the type, and rewritten when it does not.
 */
export function valueForInput(
  input: { label?: string; placeholder?: string; name?: string; type?: string },
  proposed?: string,
): string {
  const type = (input.type || '').toLowerCase();
  const blob = `${type} ${input.name || ''} ${input.label || ''} ${input.placeholder || ''}`.toLowerCase();
  const given = proposed?.trim();

  if (type === 'number' || type === 'range') {
    return numericText(given, blob.includes('phone') || blob.includes('tel') ? '5550100' : '1');
  }
  if (type === 'tel') return numericText(given, '5550100');
  if (type === 'email' || (type !== 'number' && blob.includes('email'))) {
    if (given && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(given)) return given;
    return 'qa@example.com';
  }
  if (type === 'url' || blob.includes('url') || blob.includes('website')) {
    if (given && /^https?:\/\//i.test(given)) return given;
    return 'https://example.com';
  }
  if (type === 'date' || (type !== 'datetime-local' && /\bdate\b/.test(blob))) {
    if (given && /^\d{4}-\d{2}-\d{2}$/.test(given)) return given;
    return '2026-01-15';
  }
  if (type === 'datetime-local') {
    if (given && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(given)) return given;
    return '2026-01-15T09:00';
  }
  if (type === 'time') {
    if (given && /^\d{2}:\d{2}/.test(given)) return given;
    return '09:00';
  }
  if (type === 'month') return given && /^\d{4}-\d{2}$/.test(given) ? given : '2026-01';
  if (type === 'week') return given && /^\d{4}-W\d{2}$/.test(given) ? given : '2026-W03';
  if (type === 'color') return given && /^#[0-9a-f]{6}$/i.test(given) ? given : '#336699';
  if (type === 'password') return given && given.length >= 8 ? given : 'Test-password-1';
  if (type === 'search' || blob.includes('search')) return given && given.length > 0 ? given : 'banana';
  if (blob.includes('phone') || blob.includes('tel')) return numericText(given, '5550100');
  if (blob.includes('qty') || blob.includes('quantity') || blob.includes('amount')) return numericText(given, '1');
  if (blob.includes('message') || blob.includes('comment') || type === 'textarea') {
    return given && given.length > 0 ? given : 'Hello from monkeytest';
  }
  if (blob.includes('name')) return given && given.length > 0 ? given : 'Test User';
  return given && given.length > 0 ? given : 'test';
}

/** Digits only. `555-0100` becomes `5550100`. A non-numeric word becomes `fallback`. */
export function numericText(proposed: string | undefined, fallback: string): string {
  if (proposed) {
    const trimmed = proposed.trim();
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return trimmed;
    const digits = trimmed.replace(/\D/g, '');
    if (digits) return digits;
  }
  return fallback;
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
  - "tool" and "locator" are exact lowercase strings from the lists above, not objects.
  - "target" and "value" are strings. Omit a key instead of sending null.

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

  const raw = await llm.generateJSON({
    label: 'runner.resolveAction',
    prompt,
    schema: ActionSchema,
  });
  return ActionSchema.parse(raw);

}

export interface ActionOutcome {
  status: StepStatus;
  observation: string;
  error?: string;
}

export async function executeAction(
  page: Page,
  action: ResolvedAction,
  timeoutMs: number,
  options?: { strictOracles?: boolean },
): Promise<ActionOutcome> {

  try {

    switch (action.tool){

      case 'click': {
        const locator = buildLocator(page, action);
        if (options?.strictOracles) {
          const disabled = await failIfDisabled(locator, action);
          if (disabled) return disabled;
        }
        await locator.first().click({ timeout: timeoutMs });
        await settleSPA(page).catch(() => {});
        return { status: 'passed', observation: `Clicked ${describeTarget(action)}.` };
      }

      case 'fill': {
        const locator = buildLocator(page, action);
        const meta = await readFillTarget(locator);
        if (meta?.type === 'checkbox' || meta?.type === 'radio') {
          await locator.first().check({ timeout: timeoutMs });
          return { status: 'passed', observation: `Checked ${describeTarget(action)}.` };
        }
        const safeValue = meta
          ? valueForInput(meta, action.value ?? '')
          : (action.value ?? '');
        await locator.first().fill(safeValue, { timeout: timeoutMs });
        return { status: 'passed', observation: `Typed "${truncate(safeValue, 40)}" into ${describeTarget(action)}.` };
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
          if (options?.strictOracles) {
            const disabled = await failIfDisabled(locator, action);
            if (disabled) return disabled;
          }
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
    if (isAutomationFault(msg) || isSoftAutomationMiss(msg)){
      return {
        status: 'skipped',
        observation: `Our test couldn't complete ${action.tool} on ${describeTarget(action)} (${truncate(msg, 180)}). Treated as inconclusive rather than a product bug.`,
        error: msg,
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

    function fieldLabel(el: Element): string {
      const control = el as HTMLInputElement;
      if (control.id) {
        const byFor = document.querySelector(`label[for="${CSS.escape(control.id)}"]`);
        if (byFor) {
          const text = txt(byFor);
          if (text) return text.slice(0, 80);
        }
      }
      const aria = control.getAttribute('aria-label');
      if (aria && aria.trim()) return aria.trim().replace(/\s+/g, ' ').slice(0, 80);
      const labelledBy = control.getAttribute('aria-labelledby');
      if (labelledBy) {
        const text = labelledBy.split(/\s+/).map(id => {
          const node = document.getElementById(id);
          return node ? txt(node) : '';
        }).filter(Boolean).join(' ').trim();
        if (text) return text.slice(0, 80);
      }
      const parent = control.closest('label');
      if (parent) {
        const clone = parent.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('input, textarea, select').forEach(node => node.remove());
        const text = txt(clone);
        if (text) return text.slice(0, 80);
      }
      return '';
    }

    const inputs = Array.from(document.querySelectorAll('input, textarea, select'))
      .slice(0, 25)
      .map(el => {
        const i = el as HTMLInputElement;
        const label = fieldLabel(i);
        return {
          label: label || undefined,
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
  return (lower.includes('timeout') && (
    lower.includes('waiting for locator')
    || lower.includes('locator.fill')
    || lower.includes('locator.click')
    || lower.includes('locator.press')
    || lower.includes('locator.waitfor')
  )) || lower.includes('waiting for getby');
}

async function readFillTarget(locator: Locator): Promise<{ type?: string; label?: string; name?: string; placeholder?: string } | undefined> {
  try {
    if (await locator.count() < 1) return undefined;
    return await locator.first().evaluate(el => {
      const input = el as HTMLInputElement;
      const type = (input.type || el.getAttribute('type') || '').toLowerCase();
      return {
        type: type || el.tagName.toLowerCase(),
        label: (el.getAttribute('aria-label') || '').trim() || undefined,
        name: input.name || undefined,
        placeholder: input.placeholder || undefined,
      };
    });
  } catch {
    return undefined;
  }
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
