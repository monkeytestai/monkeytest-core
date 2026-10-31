/**
 * Deterministic runner for `auth-neg-*` steps.
 *
 * Values come from the step (`value` is the synthetic email or the invalid
 * email). The password typed for the single wrong-password check is
 * `not-a-real-password` — not an account. Sign-up and forgot-password forms
 * are opened and not submitted. Captcha, phone, and payment fields abort the
 * submit. At most one LLM call is used, and only when the submit control
 * cannot be found from the DOM.
 */

import type { Page, Response } from 'playwright';
import type { LLM } from '../llm/index.js';
import type { StepStatus, TestFlow, TestStep } from '../types.js';
import { looksLikeAuthUrl, sameCrawlPage } from '../explorer/queue.js';
import { flushStepEvents, oracleFromEvidence, type StepEvidence } from './evidence.js';
import { executeAction, resolveAction, skeletonForLLM } from './actions.js';

const SYNTHETIC_PASSWORD = 'not-a-real-password';
const INVALID_EMAIL = 'not-an-email';

export interface AuthCheckOutcome {
  status: StepStatus;
  observation: string;
  error?: string;
  tool: 'click' | 'fill' | 'noop';
  target?: string;
  value?: string;
}

export async function runAuthCheck(
  page: Page,
  flow: TestFlow,
  step: TestStep,
  evidence: StepEvidence,
  stepIndex: number,
  opts: { timeoutMs: number; llm: LLM; fallbacks: { used: number } },
): Promise<AuthCheckOutcome> {
  const check = step.check;
  if (!check) {
    return { status: 'skipped', observation: 'Auth check id was missing.', tool: 'noop' };
  }
  const before = page.url();
  try {
    if (check === 'password_toggle') return await togglePassword(page);
    if (check === 'forgot_link') return await openLinkedPage(page, /forgot|reset/i, 'email');
    if (check === 'signup_link') return await openLinkedPage(page, /sign[\s-]*up|register|create an account/i, 'form');
    if (await blockedControl(page)) {
      return {
        status: 'skipped',
        observation: 'The form asks for a captcha, phone, or payment field. It was not submitted.',
        tool: 'noop',
      };
    }
    if (check === 'invalid_email') {
      const filled = await fillEmail(page, step.value || INVALID_EMAIL);
      if (!filled) return { status: 'failed', observation: 'No email field was found on the sign-in form.', error: 'no-email-field', tool: 'fill' };
    }
    if (check === 'wrong_password') {
      const email = step.value || '';
      if (!email.startsWith('monkeytest+') || !email.endsWith('@example.invalid')) {
        return {
          status: 'skipped',
          observation: 'Wrong-password check refused a value that is not a synthetic monkeytest address.',
          tool: 'noop',
        };
      }
      const filledEmail = await fillEmail(page, email);
      const filledPassword = await fillPassword(page, SYNTHETIC_PASSWORD);
      if (!filledEmail || !filledPassword) {
        return { status: 'failed', observation: 'The sign-in form did not expose both an email field and a password field.', error: 'no-auth-fields', tool: 'fill', value: email };
      }
    }
    const clicked = await clickSubmit(page, flow, step, opts);
    if (!clicked.ok) return clicked.outcome;
    await settle(page);
    if (check === 'wrong_password' || check === 'empty_submit' || check === 'invalid_email') {
      await page.locator('[role="alert"]').filter({ hasText: /\S/ }).first().waitFor({ timeout: 3_000 }).catch(() => {});
    }
    await flushStepEvents(page);
    const fault = hardFault(evidence, stepIndex);
    if (fault) return fault;
    const after = page.url();
    if (check === 'empty_submit' || check === 'invalid_email') {
      const validation = await seesValidation(page);
      const stayed = stayedOnAuth(before, after);
      if (!validation) {
        return { status: 'failed', observation: 'Submitting did not show a validation message.', error: 'no-validation', tool: 'click', target: clicked.target };
      }
      if (!stayed) {
        return { status: 'failed', observation: `The form navigated from ${before} to ${after}.`, error: 'navigated', tool: 'click', target: clicked.target };
      }
      return { status: 'passed', observation: 'Validation was shown, the page stayed on the auth screen, and no HTTP 5xx was returned.', tool: 'click', target: clicked.target, ...(check === 'invalid_email' ? { value: step.value || INVALID_EMAIL } : {}) };
    }
    const errorShown = await seesAuthError(page);
    const stayed = stayedOnAuth(before, after);
    if (!errorShown) {
      return { status: 'failed', observation: 'The wrong password did not produce an in-page error.', error: 'no-auth-error', tool: 'click', target: clicked.target, value: step.value };
    }
    if (!stayed) {
      return { status: 'failed', observation: `Wrong password left the auth page (${after}).`, error: 'navigated', tool: 'click', target: clicked.target, value: step.value };
    }
    return {
      status: 'passed',
      observation: 'An in-page error was shown, the URL stayed on the auth page, and there was no HTTP 5xx or uncaught page error.',
      tool: 'click',
      target: clicked.target,
      value: step.value,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'failed', observation: `Auth check could not finish: ${message}`, error: message, tool: 'click' };
  }
}

async function togglePassword(page: Page): Promise<AuthCheckOutcome> {
  const field = page.locator('input[type="password"], input[name="password" i], input[autocomplete="current-password"]').first();
  if (await field.count() === 0) {
    return { status: 'passed', observation: 'No password field was on the page. Recorded as info, not a bug.', tool: 'noop' };
  }
  const toggle = page.locator([
    'button',
    '[role="button"]',
    'input[type="button"]',
  ].join(', ')).filter({ hasText: /show password|hide password|reveal password|password visibility/i });
  const labelled = page.locator([
    '[aria-label*="show password" i]',
    '[aria-label*="hide password" i]',
    '[aria-label*="password visibility" i]',
    '[data-testid*="password-toggle" i]',
    '[data-testid*="show-password" i]',
  ].join(', '));
  const control = (await toggle.count()) > 0 ? toggle.first() : labelled.first();
  if (await control.count() === 0) {
    return { status: 'passed', observation: 'No password visibility toggle was found. Recorded as info, not a bug.', tool: 'noop' };
  }
  const before = await field.getAttribute('type');
  await control.click();
  await settle(page);
  const after = await field.getAttribute('type');
  if (before === after) {
    return {
      status: 'failed',
      observation: 'The password visibility toggle did not change the field.',
      error: 'password-toggle',
      tool: 'click',
    };
  }
  return { status: 'passed', observation: `Password visibility toggle changed the field from ${before || 'password'} to ${after || 'text'}.`, tool: 'click' };
}

async function openLinkedPage(page: Page, name: RegExp, expect: 'email' | 'form'): Promise<AuthCheckOutcome> {
  const link = page.getByRole('link', { name }).first();
  if (await link.count() === 0) {
    return { status: 'failed', observation: `No link matching ${name} was on the page.`, error: 'missing-link', tool: 'click' };
  }
  const href = await link.getAttribute('href');
  if (href && /^https?:/i.test(href)) {
    let target: URL;
    let here: URL;
    try {
      here = new URL(page.url());
      target = new URL(href, page.url());
    } catch {
      return { status: 'skipped', observation: 'The link target was not an http(s) URL. It was not opened.', tool: 'noop' };
    }
    if (target.origin !== here.origin) {
      return { status: 'skipped', observation: `Refused to open off-site link ${target.href}.`, tool: 'noop' };
    }
  }
  const statuses: number[] = [];
  const onResponse = (response: Response) => {
    try {
      if (response.request().resourceType() === 'document' && response.request().frame() === page.mainFrame()) {
        statuses.push(response.status());
      }
    } catch { /* response from a closing frame */ }
  };
  page.on('response', onResponse);
  await link.click({ timeout: 10_000 });
  await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
  await settle(page);
  page.off('response', onResponse);
  const status = statuses.length > 0 ? statuses[statuses.length - 1] : 200;
  if (status !== 200) {
    return { status: 'failed', observation: `The link resolved with HTTP ${status}.`, error: `http-${status}`, tool: 'click', target: href || undefined };
  }
  if (expect === 'email') {
    const emails = await page.locator('input[type="email"], input[name*="email" i], input[autocomplete="email"]').count();
    if (emails < 1) {
      return { status: 'failed', observation: 'The linked page returned HTTP 200 but has no email field.', error: 'no-email-field', tool: 'click', target: href || undefined };
    }
    return { status: 'passed', observation: 'The link returned HTTP 200 and the page has an email field. The form was not submitted.', tool: 'click', target: href || undefined };
  }
  const forms = await page.locator('form').count();
  if (forms < 1) {
    return { status: 'failed', observation: 'The linked page returned HTTP 200 but has no form.', error: 'no-form', tool: 'click', target: href || undefined };
  }
  return { status: 'passed', observation: 'The link returned HTTP 200 and the page has a form. The form was not submitted.', tool: 'click', target: href || undefined };
}

async function fillEmail(page: Page, value: string): Promise<boolean> {
  const field = page.locator('input[type="email"], input[name="email" i], input[autocomplete="username"], input[autocomplete="email"]').first();
  if (await field.count() === 0) return false;
  await field.fill(value);
  return true;
}

async function fillPassword(page: Page, value: string): Promise<boolean> {
  const field = page.locator('input[type="password"]').first();
  if (await field.count() === 0) return false;
  await field.fill(value);
  return true;
}

async function clickSubmit(
  page: Page,
  flow: TestFlow,
  step: TestStep,
  opts: { timeoutMs: number; llm: LLM; fallbacks: { used: number } },
): Promise<{ ok: true; target?: string } | { ok: false; outcome: AuthCheckOutcome }> {
  const button = page.locator('form button[type="submit"], form input[type="submit"], form button:not([type])').first();
  if (await button.count() > 0) {
    const target = (await button.innerText().catch(() => '')) || 'submit';
    await button.click({ timeout: opts.timeoutMs });
    return { ok: true, target: target.trim().slice(0, 80) };
  }
  if (opts.fallbacks.used >= 1) {
    return { ok: false, outcome: { status: 'skipped', observation: 'Submit control was not found, and the one LLM fallback for this flow was already used.', tool: 'noop' } };
  }
  opts.fallbacks.used += 1;
  try {
    const skeleton = await skeletonForLLM(page);
    const resolved = await resolveAction(opts.llm, flow, step, skeleton);
    if (resolved.tool !== 'click' && resolved.tool !== 'press') {
      return { ok: false, outcome: { status: 'skipped', observation: 'LLM fallback did not click a submit control.', tool: 'noop' } };
    }
    const executed = await executeAction(page, resolved, opts.timeoutMs);
    if (executed.status === 'failed') {
      return { ok: false, outcome: { status: 'failed', observation: executed.observation, error: executed.error, tool: 'click', target: resolved.target } };
    }
    return { ok: true, target: resolved.target };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, outcome: { status: 'skipped', observation: `Submit control was not found and the LLM fallback failed: ${message}`, tool: 'noop' } };
  }
}

async function blockedControl(page: Page): Promise<boolean> {
  const count = await page.locator([
    'iframe[src*="captcha" i]',
    'iframe[src*="recaptcha" i]',
    'iframe[src*="hcaptcha" i]',
    '[name*="captcha" i]',
    'input[type="tel"]',
    'input[autocomplete="tel"]',
    'input[autocomplete="cc-number"]',
    'input[name*="cardnumber" i]',
    'input[name*="cvv" i]',
  ].join(', ')).count();
  return count > 0;
}

function hardFault(evidence: StepEvidence, stepIndex: number): AuthCheckOutcome | undefined {
  const oracle = oracleFromEvidence(
    evidence.pageErrorsByStep.get(stepIndex) || [],
    evidence.networkByStep.get(stepIndex) || [],
  );
  if (!oracle) return undefined;
  if (oracle.error === 'http-404') return undefined;
  return { status: 'failed', observation: oracle.observation, error: oracle.error, tool: 'click' };
}

async function seesValidation(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const controls = Array.from(document.querySelectorAll('input, textarea, select'));
    if (controls.some(el => el.matches(':invalid') || el.getAttribute('aria-invalid') === 'true')) return true;
    const text = (document.body?.innerText || '').slice(0, 4000);
    return /required|invalid|valid email|enter (your |an |a )?email|please (enter|fill|provide)|must not be empty|can(?:not|'t) be empty|this field/i.test(text);
  });
}

/** Visible copy that counts as an in-page sign-in failure. */
export const AUTH_ERROR_PATTERN = [
  'incorrect',
  'not match',
  'wrong password',
  'invalid credentials',
  'invalid (?:email|login|username|user|password)',
  'email or password',
  'couldn\'t (?:sign|log) in',
  'could not (?:sign|log) in',
  'try again',
  'no account',
  'does not exist',
  'doesn\'t exist',
  'unsuccessful',
].join('|');

export function textLooksLikeAuthError(text: string): boolean {
  return new RegExp(AUTH_ERROR_PATTERN, 'i').test(text);
}

async function seesAuthError(page: Page): Promise<boolean> {
  return page.evaluate((pattern) => {
    const text = (document.body?.innerText || '').slice(0, 4000);
    return new RegExp(pattern, 'i').test(text);
  }, AUTH_ERROR_PATTERN);
}

function stayedOnAuth(before: string, after: string): boolean {
  return sameCrawlPage(before, after) || looksLikeAuthUrl(after);
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 1_500 }).catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 50));
}
