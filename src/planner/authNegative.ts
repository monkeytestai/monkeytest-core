/**
 * Sign-in checks that never use a real account.
 *
 * Built only from a crawled page that has a password field and is not a
 * sign-up or reset form. The flows use reserved ids `auth-neg-*` and kind
 * `edge_case`. They are appended after the model budget, so they do not
 * consume a planner slot, and `reconcileModelFlows` never sees them.
 *
 * The suite does not submit a sign-up form, a forgot-password form, or any
 * form that asks for a captcha, a phone number, or a payment field.
 * Wrong-password runs at most once per plan.
 */

import type { SiteMap, SiteMapControl, SiteMapFormInput, SiteMapPage, TestFlow, TestStep } from '../types.js';
import { looksLikeAuthUrl } from '../explorer/queue.js';

export const AUTH_NEG_PREFIX = 'auth-neg-';

/** Synthetic address. `example.invalid` is a reserved TLD, not a mailbox. */
export function syntheticLoginEmail(rand = Math.random().toString(36).slice(2, 10)): string {
  const token = rand.replace(/[^a-z0-9]/gi, '').slice(0, 12) || 'check';
  return `monkeytest+${token}@example.invalid`;
}

const FAKE_PASSWORD = 'not-a-real-password';
const INVALID_EMAIL = 'not-an-email';

const SIGNUP_URL = /(?:^|[/?#=&._-])(?:sign[-_]?up|register)(?=$|[/?#=&._-])/i;
const FORGOT_URL = /(?:^|[/?#=&._-])(?:forgot|reset)(?=$|[/?#=&._-])/i;
const SIGNUP_LABEL = /\b(sign[\s-]*up|register|create an account|create account)\b/i;
const FORGOT_LABEL = /\b(forgot|reset)(\s|-|_)?(your\s|my\s)?password\b|\bforgot password\b|\breset password\b/i;
const OAUTH_LABEL = /\b(continue with|sign in with|log in with|login with|sign up with)\b|\boauth\b|\bgoogle\b|\bfacebook\b|\bgithub\b|\bapple\b|\bmicrosoft\b/i;
const CAPTCHA = /\b(captcha|recaptcha|hcaptcha|turnstile)\b/i;
const PHONE = /\b(phone|mobile)\b/i;
const PAYMENT = /\b(card number|credit card|debit card|cvv|cvc|payment|billing)\b/i;

export function isAuthNegativeFlowId(id: string): boolean {
  return id.startsWith(AUTH_NEG_PREFIX);
}

export function pageHasPassword(page: Pick<SiteMapPage, 'forms' | 'inputs'>): boolean {
  return inputsOf(page).some(input => (input.type || '').toLowerCase() === 'password'
    || (input.name || '').toLowerCase() === 'password');
}

export interface AuthNegativePlan {
  flows: TestFlow[];
  /** One sentence for the plan notes. Empty when nothing was added. */
  note?: string;
}

/**
 * One sign-in page per plan. A second password page does not get another
 * wrong-password attempt. Sign-up and reset URLs are never submitted.
 */
export function buildAuthNegativeFlows(siteMap: SiteMap): AuthNegativePlan {
  const page = siteMap.pages.find(candidate =>
    pageHasPassword(candidate)
    && !SIGNUP_URL.test(pathAndQuery(candidate.url))
    && !FORGOT_URL.test(pathAndQuery(candidate.url)),
  );
  if (!page) return { flows: [] };

  const blocked = blockedField(page);
  const email = findInput(page, input => isEmailInput(input));
  const submit = submitLabel(page);
  const flows: TestFlow[] = [];

  if (!blocked && submit) {
    flows.push(flow(page, {
      id: 'auth-neg-empty-submit',
      name: 'Submit the sign-in form empty',
      description: `Submit the sign-in form at ${page.url} with no values. Does not use credentials.`,
      expectation: 'Empty submit shows validation, stays on the auth page, and does not return HTTP 5xx.',
      severityIfFails: 'major',
      steps: [{
        action: `Click "${submit}" without filling the form`,
        expectation: 'The page shows a validation message, does not navigate away, and does not return HTTP 5xx.',
        check: 'empty_submit',
      }],
    }));
  }

  if (!blocked && submit && email) {
    const label = fieldLabel(email);
    flows.push(flow(page, {
      id: 'auth-neg-invalid-email',
      name: 'Reject an invalid sign-in email',
      description: `Type an invalid email into the sign-in form at ${page.url} and submit. Does not use credentials.`,
      expectation: 'An invalid email is rejected by validation.',
      severityIfFails: 'major',
      steps: [{
        action: `Fill the "${label}" field with "${INVALID_EMAIL}" and click "${submit}"`,
        expectation: 'The page shows a validation message for the email and does not sign in.',
        value: INVALID_EMAIL,
        check: 'invalid_email',
      }],
    }));
  }

  if (!blocked && submit && email) {
    const address = syntheticLoginEmail();
    const label = fieldLabel(email);
    flows.push(flow(page, {
      id: 'auth-neg-wrong-password',
      name: 'Reject a wrong sign-in password',
      description: `One wrong-password attempt at ${page.url} using ${address}. The password is synthetic. This is the only wrong-password attempt in the run.`,
      expectation: 'The page shows an in-page error, stays on the auth page, and does not return HTTP 5xx or throw.',
      severityIfFails: 'major',
      steps: [{
        action: `Fill the "${label}" field with "${address}", fill the password with a synthetic value, and click "${submit}"`,
        expectation: 'An in-page error is shown, the URL stays on the auth page, and there is no HTTP 5xx or uncaught page error.',
        value: address,
        check: 'wrong_password',
      }],
    }));
  }

  flows.push(flow(page, {
    id: 'auth-neg-password-toggle',
    name: 'Password visibility toggle',
    description: `Check whether the password field at ${page.url} can be revealed. A missing toggle is recorded as info, not a bug.`,
    expectation: 'The password visibility toggle switches the field between password and text. A missing toggle is info, not a failure.',
    severityIfFails: 'minor',
    steps: [{
      action: 'Use the password visibility toggle',
      expectation: 'The control is present and changes the password field type. If it is absent, record info and do not file a bug.',
      check: 'password_toggle',
    }],
  }));

  const forgot = findLink(page, 'forgot');
  if (forgot) {
    flows.push(flow(page, {
      id: 'auth-neg-forgot-password',
      name: 'Open the forgot-password page',
      description: `Open "${forgot.label}" from ${page.url}. The reset form is not submitted.`,
      expectation: 'The forgot-password link opens an HTTP 200 page with an email field.',
      severityIfFails: 'major',
      steps: [{
        action: `Click "${forgot.label}"`,
        expectation: 'The link returns HTTP 200 and the page has an email field. Do not submit the form.',
        check: 'forgot_link',
      }],
    }));
  }

  const signup = findLink(page, 'signup');
  if (signup) {
    flows.push(flow(page, {
      id: 'auth-neg-signup-link',
      name: 'Open the sign-up page',
      description: `Open "${signup.label}" from ${page.url}. The sign-up form is not submitted.`,
      expectation: 'The sign-up link opens an HTTP 200 page with a form.',
      severityIfFails: 'major',
      steps: [{
        action: `Click "${signup.label}"`,
        expectation: 'The link returns HTTP 200 and the page has a form. Do not submit the form.',
        check: 'signup_link',
      }],
    }));
  }

  if (flows.length === 0) return { flows: [] };
  const skipped = blocked
    ? ` Sign-in submit checks were not added because the form asks for ${blocked}.`
    : '';
  return {
    flows,
    note: `Added ${flows.length} sign-in checks that do not use real credentials.${skipped}`,
  };
}

function flow(page: SiteMapPage, spec: {
  id: string;
  name: string;
  description: string;
  expectation: string;
  severityIfFails: TestFlow['severityIfFails'];
  steps: TestStep[];
}): TestFlow {
  return {
    id: spec.id,
    name: spec.name.slice(0, 80),
    description: spec.description,
    kind: 'edge_case',
    startUrl: page.url,
    steps: spec.steps,
    expectation: spec.expectation,
    severityIfFails: spec.severityIfFails,
  };
}

function inputsOf(page: Pick<SiteMapPage, 'forms' | 'inputs'>): SiteMapFormInput[] {
  if (page.inputs && page.inputs.length > 0) return page.inputs;
  return (page.forms ?? []).flatMap(form => form.inputs ?? form.fields.map(token => ({ name: token, type: token })));
}

function isEmailInput(input: SiteMapFormInput): boolean {
  const type = (input.type || '').toLowerCase();
  const blob = `${type} ${input.name || ''} ${input.label || ''} ${input.placeholder || ''}`.toLowerCase();
  if (type === 'password' || type === 'hidden') return false;
  return type === 'email' || /\bemail\b/.test(blob);
}

function findInput(page: SiteMapPage, pred: (input: SiteMapFormInput) => boolean): SiteMapFormInput | undefined {
  return inputsOf(page).find(pred);
}

function fieldLabel(input: SiteMapFormInput): string {
  return (input.label || input.name || input.placeholder || 'Email').replace(/["“”]/g, "'");
}

function submitLabel(page: SiteMapPage): string | undefined {
  for (const form of page.forms ?? []) {
    if (form.submitLabel && !OAUTH_LABEL.test(form.submitLabel)) return form.submitLabel;
  }
  const button = (page.controls ?? []).find(control =>
    control.kind === 'button'
    && !control.disabled
    && !OAUTH_LABEL.test(control.label)
    && /\b(sign\s?in|log\s?in|login|submit|continue)\b/i.test(control.label),
  );
  return button?.label;
}

function findLink(page: SiteMapPage, kind: 'forgot' | 'signup'): SiteMapControl | undefined {
  const labelRe = kind === 'forgot' ? FORGOT_LABEL : SIGNUP_LABEL;
  const urlRe = kind === 'forgot' ? FORGOT_URL : SIGNUP_URL;
  return (page.controls ?? []).find(control => {
    if (control.kind !== 'link' || control.disabled) return false;
    if (OAUTH_LABEL.test(control.label) || (control.href && OAUTH_LABEL.test(control.href))) return false;
    if (control.href && !sameOrigin(control.href, page.url)) return false;
    return labelRe.test(control.label) || Boolean(control.href && urlRe.test(control.href));
  });
}

function blockedField(page: SiteMapPage): 'captcha' | 'phone' | 'payment' | undefined {
  const inputs = inputsOf(page);
  const blob = inputs.map(input =>
    `${input.type || ''} ${input.name || ''} ${input.label || ''} ${input.placeholder || ''}`,
  ).join(' ');
  const controls = (page.controls ?? []).map(control => control.label).join(' ');
  const text = `${blob} ${controls}`;
  if (CAPTCHA.test(text)) return 'captcha';
  if (inputs.some(input => (input.type || '').toLowerCase() === 'tel') || PHONE.test(blob)) return 'phone';
  if (PAYMENT.test(text)) return 'payment';
  return undefined;
}

function pathAndQuery(value: string): string {
  try {
    const url = new URL(value);
    return `${url.pathname}${url.search}`;
  } catch {
    return value;
  }
}

function sameOrigin(href: string, scope: string): boolean {
  try {
    const target = new URL(href, scope);
    const base = new URL(scope);
    return target.origin === base.origin;
  } catch {
    return false;
  }
}

/** True when the URL itself is an auth wall, even with no password field yet. */
export function pageIsAuthWall(page: Pick<SiteMapPage, 'url' | 'authGated' | 'forms' | 'inputs'>): boolean {
  return Boolean(page.authGated) || pageHasPassword(page) || looksLikeAuthUrl(page.url);
}
