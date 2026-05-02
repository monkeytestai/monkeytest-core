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

  const prompt = `
You are a senior QA engineer turning an exploratory crawl into a concrete test plan.

Constraints:
  - Produce AT MOST ${maxFlows} flows total. Prioritise flows that protect the most user value.
  - Each flow should be runnable by a Playwright agent with no human input. Use only data
    that the explorer has surfaced or that a real anonymous visitor could reasonably provide
    (e.g. searching for a generic term, browsing a category, opening the contact form).
  - DO NOT include flows that require credentials we don't have${includeAuth ? '' : ' — skip auth-gated pages entirely'}.
    ${includeAuth
      ? 'You MAY include flows for auth-gated pages, but mark them kind="auth_required" so the runner can flag them as "needs credentials" instead of failing.'
      : ''}
  - Be practical. "Click sign-up button → check the form appears" is great. "Complete a real signup with a real email" is not.
  - Behave like an exploratory user, not a brittle unit test. Prefer actions and observations over exact assertions.
  - Do NOT invent functionality. If the crawl did not show a search box, form, menu, or button, do not create a flow for it.
  - Do NOT assert exact document titles such as "Show | Hacker News"; titles vary and are not user-critical.
  - For each flow, give a 1-sentence expectation about user-visible behaviour, not exact title/text unless that exact text came from the explored page content.

Each flow has the shape:
  {
    "id": kebab-case unique within the plan, e.g. "homepage-cta",
    "name": short human title (max 80 chars),
    "description": one sentence of what this flow tests,
    "kind": "happy_path" | "edge_case" | "auth_required" | "destructive" | "accessibility" | "visual",
    "startUrl": absolute URL — usually one of the visited pages,
    "steps": array of { "action": "...", "expectation"?: "..." }, 1–8 items,
    "expectation": one-sentence success criterion for the whole flow,
    "severityIfFails": "critical" | "major" | "minor"
  }

Site:        ${siteMap.startUrl}
Site type:   ${siteMap.siteType}
Description: ${siteMap.summary}

Pages explored:
${siteMap.pages.map(p => `
  - URL: ${p.url}
    title: ${p.title}
    summary: ${p.summary}
    auth-gated: ${p.authGated}
    interactive:
      ${p.interactive.length === 0 ? '(none)' : p.interactive.map(i => `${i.kind} "${i.label}"`).join(', ')}
`).join('')}

Reply with JSON:
{
  "flows": [ ... ],
  "notes": "(optional caveats)"
}
`;

  const result = await llm.generateJSON({
    label: 'planner.generate',
    prompt,
    schema: PlanSchema,
  });

  // Final pass: dedupe IDs and re-shape into the public TestPlan type.
  const seen = new Set<string>();
  const flows: TestFlow[] = result.flows.map((f, i) => {
    let id = f.id;
    if (seen.has(id)){
      id = `${id}-${i + 1}`;
    }
    seen.add(id);
    return { ...f, id };
  });

  events.emit({
    phase: 'planner', type: 'plan.complete',
    message: `Plan ready: ${flows.length} flow${flows.length === 1 ? '' : 's'} to execute.`,
    data: {
      flows: flows.length,
      flowNames: flows.map(f => f.name),
    },
  });

  return {
    startUrl: siteMap.startUrl,
    siteType: siteMap.siteType,
    flows,
    notes: result.notes,
  };

}
