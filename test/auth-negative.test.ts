/**
 * Phase 1: a sign-in-first site still yields auth-negative cases.
 * The stub LLM invents a pricing journey and two Google clicks. Neither
 * survives. No provider key is read.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ENGINE_VERSION,
  countPublicScreens,
  deriveRunOutcome,
  triage,
} from '../src/index.js';
import {
  looksLikeAuthUrl,
  planCrawlOrder,
  seedCrawlQueue,
  urlsFromRobots,
  urlsFromSitemap,
} from '../src/explorer/queue.js';
import { explore } from '../src/explorer/index.js';
import { plan } from '../src/planner/index.js';
import { buildAuthNegativeFlows } from '../src/planner/authNegative.js';
import { textLooksLikeAuthError } from '../src/runner/authNegative.js';
import { runPlan } from '../src/runner/index.js';
import type { LLM } from '../src/llm/index.js';
import type { RunResult, SiteMap, TestFlow, TestPlan } from '../src/types.js';
import { startSigninSpa, type SigninSpa } from './fixtures/signin-spa/server.js';

describe('auth URL detection and seeds', () => {
  it('recognises mode, hyphen, and underscore auth URLs', () => {
    expect(looksLikeAuthUrl('https://shop.example/?mode=signin')).toBe(true);
    expect(looksLikeAuthUrl('https://shop.example/?mode=signup')).toBe(true);
    expect(looksLikeAuthUrl('https://shop.example/?mode=sign-in')).toBe(true);
    expect(looksLikeAuthUrl('https://shop.example/?mode=sign_up')).toBe(true);
    expect(looksLikeAuthUrl('https://shop.example/forgot-password')).toBe(true);
    expect(looksLikeAuthUrl('https://shop.example/reset-password')).toBe(true);
    expect(looksLikeAuthUrl('https://shop.example/login')).toBe(true);
    expect(looksLikeAuthUrl('https://shop.example/author')).toBe(false);
    expect(looksLikeAuthUrl('https://shop.example/help')).toBe(false);
  });

  it('seeds the root and the query-less start URL, and keeps three auth links', () => {
    const start = 'https://shop.example/app/login?mode=signin';
    const seeded = seedCrawlQueue(start).map(item => item.url);
    expect(seeded[0]).toBe(start);
    expect(seeded).toContain('https://shop.example/');
    expect(seeded).toContain('https://shop.example/app/login');

    const order = planCrawlOrder({
      startUrl: 'https://shop.example/?mode=signin',
      maxPages: 6,
      edges: {
        'https://shop.example/?mode=signin': [
          { url: 'https://shop.example/?mode=signup', text: 'Sign up' },
          { url: 'https://shop.example/forgot-password', text: 'Forgot password' },
          { url: 'https://shop.example/otp', text: 'Code' },
          { url: 'https://shop.example/register', text: 'Register' },
          { url: 'https://accounts.google.com/o/oauth2/v2/auth', text: 'Continue with Google' },
        ],
      },
    });
    expect(order).toContain('https://shop.example/?mode=signup');
    expect(order).toContain('https://shop.example/forgot-password');
    expect(order).toContain('https://shop.example/otp');
    expect(order).not.toContain('https://shop.example/register');
    expect(order).not.toContain('https://accounts.google.com/o/oauth2/v2/auth');
  });

  it('reads sitemap locs and robots Allow paths', () => {
    expect(urlsFromSitemap('<urlset><url><loc>https://shop.example/?mode=signup</loc></url></urlset>'))
      .toEqual(['https://shop.example/?mode=signup']);
    expect(urlsFromRobots([
      'User-agent: *',
      'Allow: /',
      'Allow: /forgot-password',
      'Sitemap: https://shop.example/sitemap.xml',
    ].join('\n'), 'https://shop.example/')).toEqual([
      'https://shop.example/forgot-password',
      'https://shop.example/sitemap.xml',
    ]);
  });
});

describe('auth-negative plan', () => {
  it('adds five or more reserved flows and does not submit signup or a captcha form', () => {
    const built = buildAuthNegativeFlows(signinMap());
    const ids = built.flows.map(flow => flow.id);
    expect(ids.filter(id => id.startsWith('auth-neg-')).length).toBeGreaterThanOrEqual(5);
    expect(ids.filter(id => id === 'auth-neg-wrong-password')).toEqual(['auth-neg-wrong-password']);
    expect(built.flows.every(flow => flow.kind === 'edge_case')).toBe(true);
    const wrong = built.flows.find(flow => flow.id === 'auth-neg-wrong-password');
    expect(wrong?.steps[0].value).toMatch(/^monkeytest\+[a-z0-9]+@example\.invalid$/);
    expect(built.flows.some(flow => flow.id === 'auth-neg-forgot-password')).toBe(true);
    expect(built.flows.some(flow => flow.id === 'auth-neg-signup-link')).toBe(true);

    const captcha = buildAuthNegativeFlows(signinMap({ captcha: true }));
    expect(captcha.flows.some(flow => flow.id === 'auth-neg-wrong-password')).toBe(false);
    expect(captcha.flows.some(flow => flow.id === 'auth-neg-empty-submit')).toBe(false);
  });

  it('drops invented and off-site flows without removing auth-neg checks', async () => {
    const llm = inventingLlm();
    const result = await plan(signinMap(), llm, { maxFlows: 4, focus: 'forms-search-cta' });
    const auth = result.flows.filter(flow => flow.id.startsWith('auth-neg-'));
    expect(auth.length).toBeGreaterThanOrEqual(5);
    expect(result.flows.filter(flow => flow.id === 'auth-neg-wrong-password')).toHaveLength(1);
    const actions = result.flows.flatMap(flow => flow.steps.map(step => step.action)).join('\n');
    expect(actions).not.toMatch(/view pricing/i);
    expect(actions).not.toMatch(/google/i);
    expect(duplicateClicks(result.flows.filter(flow => !flow.id.startsWith('auth-neg-')))).toEqual([]);
    expect(result.flows.length).toBeGreaterThan(4);
  });
});

describe('login-only outcome', () => {
  it('uses login_required and public_screens 0 when the auth checks passed', () => {
    const run = triage(passedAuthRun(), { pagesVisited: 3, publicScreens: 0 });
    expect(run.outcome).toBe('clean');
    expect(run.outcome).not.toBe('inconclusive');
    expect(run.outcome_reason).toBe('login_required');
    expect(run.outcome_detail).toMatch(/account/i);
    expect(run.public_screens).toBe(0);
    expect(run.engine_version).toBe(ENGINE_VERSION);
    expect(run.signup_attempted).toBeUndefined();
    expect(run.signup_verified).toBeUndefined();
    expect(run.signup_status).toBeUndefined();
    expect(run.signup_reason).toBeUndefined();
  });

  it('keeps login_required beside bugs found on a login-only crawl', () => {
    const derived = deriveRunOutcome({
      ...passedAuthRun(),
      bugs: [{
        id: 'bug-1',
        fingerprint: 'fp',
        title: 'Empty submit navigated away',
        severity: 'major',
        category: 'functional',
        expected: 'Validation',
        observed: 'Navigated away',
        reproSteps: [],
        affectedFlow: 'Submit the sign-in form empty',
        evidence: { screenshots: [], consoleErrors: [], networkFailures: [] },
      }],
    }, { pagesVisited: 3, publicScreens: 0 });
    expect(derived.outcome).toBe('bugs_found');
    expect(derived.outcome_reason).toBe('login_required');
    expect(derived.outcome_detail).toMatch(/account/i);
  });
});

describe('in-page auth errors', () => {
  it('accepts the supabase wording and rejects a bare validation hint', () => {
    expect(textLooksLikeAuthError('Invalid email or password')).toBe(true);
    expect(textLooksLikeAuthError('Incorrect email or password')).toBe(true);
    expect(textLooksLikeAuthError('Enter a valid email')).toBe(false);
  });
});

describe('ENGINE_VERSION', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(ENGINE_VERSION).toBe(pkg.version);
    expect(countPublicScreens([{ authGated: true }, { authGated: false }, { authGated: true }])).toBe(1);
  });
});

describe('sign-in-first fixture', () => {
  let spa: SigninSpa;
  const shots = mkdtempSync(join(tmpdir(), 'monkeytest-signin-'));
  const llmCalls: string[] = [];

  beforeAll(async () => {
    spa = await startSigninSpa();
  });

  afterAll(async () => {
    await spa.close();
  });

  it('crawls 3 or more pages, runs the auth checks once, and does not finish inconclusive', async () => {
    const started = Date.now();
    const llm = inventingLlm(llmCalls);
    const siteMap = await explore(`${spa.url}/?mode=signin`, llm, { maxPages: 6, headless: true });
    expect(siteMap.pages.length).toBeGreaterThanOrEqual(3);
    expect(siteMap.pages.some(page => page.url.includes('accounts.google.com'))).toBe(false);
    expect(countPublicScreens(siteMap.pages)).toBe(0);
    expect(siteMap.pages.every(page => page.authGated)).toBe(true);

    const testPlan = await plan(siteMap, llm, { maxFlows: 4, focus: 'forms-search-cta' });
    const auth = testPlan.flows.filter(flow => flow.id.startsWith('auth-neg-'));
    expect(auth.length).toBeGreaterThanOrEqual(5);
    expect(testPlan.flows.filter(flow => flow.id === 'auth-neg-wrong-password')).toHaveLength(1);
    const actions = testPlan.flows.flatMap(flow => flow.steps.map(step => step.action)).join('\n');
    expect(actions).not.toMatch(/google/i);
    expect(actions).not.toMatch(/view pricing/i);
    expect(duplicateClicks(testPlan.flows.filter(flow => !flow.id.startsWith('auth-neg-')))).toEqual([]);

    const raw = await runPlan(testPlan, llm, {
      screenshotsDir: shots,
      headless: true,
      recordVideo: false,
      strictOracles: true,
      failOn5xx: true,
    });
    const run = triage(raw, {
      pagesVisited: siteMap.pages.length,
      publicScreens: countPublicScreens(siteMap.pages),
      notes: testPlan.notes,
    });
    const elapsed = Date.now() - started;

    expect(spa.loginPosts()).toBe(1);
    expect(run.outcome).toBe('clean');
    expect(run.outcome_reason).toBe('login_required');
    expect(run.public_screens).toBe(0);
    expect(run.engine_version).toBe(ENGINE_VERSION);
    expect(run.signup_attempted).toBeUndefined();
    expect(llmCalls.filter(label => label === 'runner.resolveAction')).toHaveLength(0);
    expect(elapsed).toBeLessThan(120_000);
  }, 120_000);

  it('does not file a bug when the password toggle is absent', async () => {
    const planOnly: TestPlan = {
      startUrl: `${spa.url}/?mode=signin&notoggle=1`,
      siteType: 'auth',
      flows: [{
        id: 'auth-neg-password-toggle',
        name: 'Password visibility toggle',
        description: 'Missing toggle is info.',
        kind: 'edge_case',
        startUrl: `${spa.url}/?mode=signin&notoggle=1`,
        steps: [{
          action: 'Use the password visibility toggle',
          expectation: 'Absence is info, not a bug.',
          check: 'password_toggle',
        }],
        expectation: 'Absence is info, not a bug.',
        severityIfFails: 'minor',
      }],
    };
    const raw = await runPlan(planOnly, inventingLlm(), {
      screenshotsDir: shots,
      headless: true,
      recordVideo: false,
      strictOracles: true,
    });
    const run = triage(raw, { pagesVisited: 1, publicScreens: 0 });
    expect(run.bugs).toHaveLength(0);
    expect(run.flows[0].steps[0].status).toBe('passed');
    expect(run.flows[0].steps[0].observation).toMatch(/info/i);
    expect(run.outcome).not.toBe('inconclusive');
  }, 60_000);
});

function inventingLlm(calls: string[] = []): LLM {
  return {
    providerLabel: 'stub',
    async generateJSON({ label }) {
      calls.push(label || '');
      if (label === 'planner.generate') {
        return {
          flows: [pricingFlow(), googleFlow('google-fault'), googleFlow('google-cta')],
          notes: 'Invented a pricing journey and clicked Google twice.',
        };
      }
      throw new Error(`stub refused ${label || 'unlabelled call'}`);
    },
  };
}

function pricingFlow(): TestFlow {
  return {
    id: 'view-pricing',
    name: 'View pricing',
    description: 'Open the pricing page that was not crawled.',
    kind: 'happy_path',
    startUrl: 'https://example.com/pricing',
    steps: [{ action: 'Click "View pricing"', expectation: 'Pricing loads.' }],
    expectation: 'The pricing page loads.',
    severityIfFails: 'major',
  };
}

function googleFlow(id: string): TestFlow {
  return {
    id,
    name: 'Continue with Google',
    description: 'Leave the site through the OAuth button.',
    kind: 'happy_path',
    startUrl: 'https://shop.example/?mode=signin',
    steps: [{ action: 'Click "Continue with Google"', expectation: 'Google opens.' }],
    expectation: 'The OAuth provider opens.',
    severityIfFails: 'major',
  };
}

function signinMap(opts: { captcha?: boolean } = {}): SiteMap {
  const controls: SiteMap['pages'][number]['controls'] = [
    { kind: 'button', label: 'Sign in' },
    { kind: 'button', label: 'Show password' },
    { kind: 'link', label: 'Forgot password', href: 'https://shop.example/forgot-password' },
    { kind: 'link', label: 'Sign up', href: 'https://shop.example/?mode=signup' },
    { kind: 'link', label: 'Continue with Google', href: 'https://accounts.google.com/o/oauth2/v2/auth' },
  ];
  if (opts.captcha) controls.push({ kind: 'button', label: 'I am not a robot' });
  return {
    startUrl: 'https://shop.example/?mode=signin',
    siteType: 'auth',
    summary: 'A sign-in wall.',
    pages: [
      {
        url: 'https://shop.example/?mode=signin',
        title: 'Sign in',
        summary: 'Sign-in form.',
        interactive: [],
        outboundLinks: ['https://shop.example/?mode=signup', 'https://shop.example/forgot-password'],
        authGated: true,
        forms: [{
          action: '',
          method: 'get',
          fields: ['email', 'password'],
          inputs: [
            { name: 'email', label: 'Email', type: 'email' },
            { name: 'password', label: 'Password', type: 'password' },
            ...(opts.captcha ? [{ name: 'g-recaptcha-response', label: 'Captcha', type: 'text' }] : []),
          ],
          submitLabel: 'Sign in',
        }],
        controls,
      },
      {
        url: 'https://shop.example/?mode=signup',
        title: 'Create account',
        summary: 'Sign-up form.',
        interactive: [],
        outboundLinks: [],
        authGated: true,
        forms: [{
          action: '',
          method: 'get',
          fields: ['email'],
          inputs: [{ name: 'email', label: 'Email', type: 'email' }],
          submitLabel: 'Create account',
        }],
      },
      {
        url: 'https://shop.example/forgot-password',
        title: 'Forgot password',
        summary: 'Reset form.',
        interactive: [],
        outboundLinks: [],
        authGated: true,
        forms: [{
          action: '',
          method: 'get',
          fields: ['email'],
          inputs: [{ name: 'email', label: 'Email', type: 'email' }],
          submitLabel: 'Send reset link',
        }],
      },
    ],
    pendingUrls: [],
    failedUrls: [],
  };
}

function duplicateClicks(flows: TestFlow[]): string[] {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const flow of flows) {
    const label = flow.steps.map(step => step.action).join(' ').match(/\bclick(?:ing)?\s+(?:the\s+)?["“]([^"”]+)["”]/i)?.[1];
    if (!label) continue;
    const key = `${flow.startUrl}|${label.toLowerCase()}`;
    if (seen.has(key)) dupes.push(key);
    seen.add(key);
  }
  return dupes;
}

function passedAuthRun(): RunResult {
  return {
    startUrl: 'https://shop.example/?mode=signin',
    startedAt: '2026-10-31T00:00:00.000Z',
    finishedAt: '2026-10-31T00:00:02.000Z',
    flows: [{
      flowId: 'auth-neg-empty-submit',
      name: 'Submit the sign-in form empty',
      description: 'Empty submit.',
      kind: 'edge_case',
      startUrl: 'https://shop.example/?mode=signin',
      status: 'passed',
      steps: [{
        index: 1,
        action: 'Click "Sign in" without filling the form',
        status: 'passed',
        observation: 'Validation was shown.',
      }],
      durationMs: 20,
      bugIds: [],
    }],
    bugs: [],
    stats: {
      flowsTotal: 1,
      flowsPassed: 1,
      flowsFailed: 0,
      flowsBlocked: 0,
      flowsInconclusive: 0,
      stepsTotal: 1,
      stepsPassed: 1,
      stepsFailed: 0,
      bugsCritical: 0,
      bugsMajor: 0,
      bugsMinor: 0,
    },
  };
}
