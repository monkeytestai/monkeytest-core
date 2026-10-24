/**
 * Planner phase
 *
 * Converts a SiteMap into a TestPlan: a list of TestFlows that a real user
 * would care about. The planner is told which pages the explorer found, what
 * each one does, what's interactive on it — and asked to pick the most
 * impactful flows to verify.
 *
 * It does NOT generate exhaustive test cases. The runner (next phase) is
 * adversarial and will discover edge cases by behaviour. The planner only
 * needs to give it well-shaped happy paths to anchor the exploration.
 */

import { z } from 'zod';
import type { LLM } from '../llm/index.js';
import type { SiteMap, TestPlan, TestFlow } from '../types.js';
import { type EventBus, noopBus } from '../events.js';
import { ensurePublicFormFlow } from './forms.js';
import { ensureFaultSurfaceFlows } from './faults.js';

export interface PlannerOptions {
  /** Soft cap on flows per plan. Default 6. */
  maxFlows?: number;
  /** Include flows that require auth (the runner will surface them as "needs creds"). Default true. */
  includeAuthFlows?: boolean;
  /** Optional live event bus. Receives planner lifecycle events. */
  events?: EventBus;
}

const FlowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(3),
  description: z.string().min(3),
  kind: z.enum(['happy_path', 'edge_case', 'auth_required', 'destructive', 'accessibility', 'visual']),
  startUrl: z.string().url(),
  steps: z.array(z.object({
    action: z.string().min(3),
    expectation: z.string().optional(),
  })).min(1),
  expectation: z.string().min(3),
  severityIfFails: z.enum(['critical', 'major', 'minor']),
});

const PlanSchema = z.object({
  flows: z.array(FlowSchema).min(1),
  notes: z.string().optional(),
});

export async function plan(
  siteMap: SiteMap,
  llm: LLM,
  opts: PlannerOptions = {}
): Promise<TestPlan> {

  const maxFlows = opts.maxFlows ?? 6;
  const includeAuth = opts.includeAuthFlows ?? true;
  const events = opts.events ?? noopBus();

  if (siteMap.pages.length === 0){
    events.emit({
      phase: 'planner', type: 'plan.skipped',
      message: 'Planner skipped: no pages were successfully explored.',
    });
    return {
      startUrl: siteMap.startUrl,
      siteType: siteMap.siteType,
      flows: [],
      notes: 'Planner skipped: no pages were successfully explored.',
    };
  }

  events.emit({
    phase: 'planner', type: 'plan.start',
    message: `Generating test plan from ${siteMap.pages.length} page${siteMap.pages.length === 1 ? '' : 's'}…`,
    data: { pages: siteMap.pages.length, siteType: siteMap.siteType },
  });

  // Prompt is intentionally split into THREE parts to maximise prompt-cache
  // hits across runs against the same site:
  //
  //   1. `system`     — never changes. Identical across every planner call
  //                     in the engine's lifetime. Anthropic caches it via
  //                     a system-block ephemeral breakpoint; OpenAI caches
  //                     it as part of the message-prefix hash.
  //   2. `cacheable`  — the long stable site-map dump. Identical across all
  //                     calls against the same site. This is by far the
  //                     largest token block in the prompt — caching it has
  //                     the most impact.
  //   3. `prompt`     — the small per-call instructions (maxFlows, auth
  //                     toggle, schema reminder). Tiny, cheap to re-send.
  //
  // Order matters: providers cache by *prefix*, so the dynamic bit goes LAST.
  const system = `You are a senior QA architect. You have just been handed a structured crawl of a real website. Your job is to design a small set of high-quality user journeys — the kind a staff engineer would put on a release checklist — not a pile of brittle UI assertions.

How to think:
  1. First understand the product: who is the visitor, what jobs can they complete without an account, what is marketing vs. application vs. legal.
  2. Then pick DISTINCT journeys that protect the most user value (apply, shop, compare, contact, read a key page, complete a public form).
  3. Each flow must be a realistic anonymous-visitor path using ONLY controls the crawl actually saw.

Hard rules:
  - Do NOT invent search boxes, menus, buttons, forms, or pages the crawl did not show.
  - Do NOT assert exact document titles. Titles vary and are not user-critical.
  - Prefer visible labels from the crawl ("Apply now", "Check eligibility") over CSS selectors.
  - Steps must be executable by a Playwright agent with no human, OTP, email, or password.
  - One goal per flow. Do not duplicate the same journey with different wording.
  - Prefer 4–7 concrete steps. Skip "look at the page" filler.
  - severityIfFails = critical only if a real user cannot complete a core job (apply, pay, submit, checkout). Visual polish is minor.

Each flow has the shape:
  {
    "id": kebab-case unique within the plan, e.g. "homepage-cta",
    "name": short human title (max 80 chars),
    "description": one sentence of what this flow tests and why it matters,
    "kind": "happy_path" | "edge_case" | "auth_required" | "destructive" | "accessibility" | "visual",
    "startUrl": absolute URL — usually one of the visited pages,
    "steps": array of { "action": "...", "expectation"?: "..." }, 1–8 items,
    "expectation": one-sentence success criterion for the whole flow,
    "severityIfFails": "critical" | "major" | "minor"
  }`;

  const journeys = (siteMap.publicJourneys || []).filter(Boolean);
  const authSurfaces = (siteMap.authSurfaces || []).filter(Boolean);

  const cacheable = `Site:        ${siteMap.startUrl}
Product:     ${siteMap.productName || '(not named)'}
Site type:   ${siteMap.siteType}
Description: ${siteMap.summary}
Public journeys a visitor can complete:
${journeys.length ? journeys.map(j => `  - ${j}`).join('\n') : '  (none inferred — infer carefully from pages below)'}
Login / account surfaces noticed (do not enter unless instructed):
${authSurfaces.length ? authSurfaces.map(s => `  - ${s}`).join('\n') : '  (none)'}

Pages explored:
${siteMap.pages.map(p => `
  - URL: ${p.url}
    title: ${p.title}
    summary: ${p.summary}
    auth-gated: ${p.authGated}
    interactive:
      ${p.interactive.length === 0 ? '(none)' : p.interactive.map(i => `${i.kind} "${i.label}"`).join(', ')}
    forms:
      ${p.forms?.length
        ? p.forms.map(f => `${(f.method || 'get').toUpperCase()} ${f.action || '(no action)'} fields=[${f.fields.join(', ') || 'none'}] submit="${f.submitLabel || ''}"`).join(' | ')
        : '(none)'}
    controls:
      ${p.controls?.length
        ? p.controls.slice(0, 12).map(c => `${c.kind}${c.disabled ? ' disabled' : ''} "${c.label}"${c.href ? ` -> ${c.href}` : ''}`).join(', ')
        : '(none)'}
`).join('')}`;

  const prompt = `Now produce the test plan.

Per-call constraints:
  - Produce AT MOST ${maxFlows} flows total. Fill the quota with executable public journeys first.
  - Every step must name a control or content that appears in the crawl above.
  - ${includeAuth
      ? 'You MAY add at most one kind="auth_required" flow that reaches a login/OTP wall and then stops. Do not invent credentials. The runner will skip executing it.'
      : 'Do NOT include login, sign-in, sign-up, register, OTP, password-reset, or any flow that needs an account. Skip auth-gated pages. Fill the plan with public journeys only.'}
  - If a crawled page lists a public form under "forms:", one of the flows MUST start on that page and submit that form when the flow budget is at least 1. Prefer a POST contact, help, support, or feedback form over a search box. Use only the scraped fields and submit label. Do not invent a form URL or a field the crawl did not list.
  - Scraped "controls:" are real buttons and links. The engine also keeps grounded flows for an enabled button, a link whose target was not crawled, and a disabled button when the budget allows. Do not invent a control that is not listed.

Reply with JSON:
{
  "flows": [ ... ],
  "notes": "(optional: what you understood about the site and what you deliberately skipped)"
}`;

  const result = await llm.generateJSON({
    label: 'planner.generate',
    system,
    cacheable,
    prompt,
    schema: PlanSchema,
  });

  // Final pass: dedupe IDs, drop login journeys when the host asked us not
  // to plan them (LLMs still sneak them in), and re-shape into TestPlan.
  const seen = new Set<string>();
  let flows: TestFlow[] = result.flows.map((f, i) => {
    let id = f.id;
    if (seen.has(id)){
      id = `${id}-${i + 1}`;
    }
    seen.add(id);
    return { ...f, id };
  });

  if (!includeAuth){
    const publicOnly = flows.filter(f => !looksLikeLoginFlow(f));
    if (publicOnly.length > 0) flows = publicOnly;
  }

  flows = flows.slice(0, maxFlows);

  // Floor under the LLM: a public form that was actually crawled still gets
  // one submit flow when maxFlows allows, even if the model only planned shop
  // journeys. The flow's URL and fields come from the sitemap.
  const ensured = ensurePublicFormFlow(flows, siteMap, maxFlows);
  const faults = ensureFaultSurfaceFlows(ensured.flows, siteMap, maxFlows);
  flows = faults.flows;
  const notes = [
    result.notes,
    ensured.injected ? 'Added a form-submit flow for a public form found in the crawl.' : '',
    faults.added.length
      ? `Added fault-surface flows for controls the crawl saw (${faults.added.join(', ')}).`
      : '',
  ].filter(Boolean).join(' ') || undefined;

  // Surface prompt-cache stats so the SaaS can display "saved $X" tooltips.
  const usage = llm.lastUsage;
  events.emit({
    phase: 'planner', type: 'plan.complete',
    message: `Plan ready: ${flows.length} flow${flows.length === 1 ? '' : 's'} to execute.`,
    data: {
      flows: flows.length,
      flowNames: flows.map(f => f.name),
      ...(usage ? { usage } : {}),
    },
  });

  return {
    startUrl: siteMap.startUrl,
    siteType: siteMap.siteType,
    flows,
    notes,
  };

}

function looksLikeLoginFlow(f: { kind: string; name: string; description: string; steps: { action: string }[] }): boolean {
  if (f.kind === 'auth_required') return true;
  const text = [f.name, f.description, ...f.steps.map(s => s.action)].join(' ').toLowerCase();
  return /\b(log\s?in|sign\s?in|sign\s?up|register|create an account|otp|one[- ]time (code|password)|password reset|forgot password|verify (your )?(phone|email)|enter (your )?otp)\b/.test(text);
}
