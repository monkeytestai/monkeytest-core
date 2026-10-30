/**
 * Optional one-call verdict (`planner.verdict`).
 *
 * The sentence that ships is `alignVerdict`: an LLM draft is kept only when
 * it agrees with the filtered bug count. A contradiction, including "worked
 * smoothly" next to a bug or "major bug" when nothing was confirmed, is
 * replaced by the deterministic `outcome_detail`.
 */

import { z } from 'zod';
import type { LLM } from '../llm/index.js';
import { alignVerdict, type OutcomeContext } from '../outcome.js';
import type { RunResult } from '../types.js';

const VerdictSchema = z.object({
  verdict: z.string().min(12).max(500),
});

export async function applyPlannerVerdict(
  run: RunResult,
  llm: LLM | undefined,
  _ctx: OutcomeContext = {},
): Promise<RunResult> {
  if (!llm || !run.outcome || !run.outcome_detail) return run;
  const facts = {
    bugCount: run.bugs.length,
    outcome: run.outcome,
    outcome_detail: run.outcome_detail,
  };
  try {
    const raw = await llm.generateJSON({
      label: 'planner.verdict',
      system: 'You write one short verdict for an exploratory test run. Reply with JSON only: {"verdict":"..."}.',
      prompt: `Facts you must not contradict:
  outcome: ${run.outcome}
  confirmed bugs: ${run.bugs.length}
  ${run.outcome_reason ? `reason: ${run.outcome_reason}` : 'reason: (none)'}

Rules:
  - If confirmed bugs is greater than 0, describe the bug. Do not say the site worked smoothly, and do not say there were no bugs.
  - If confirmed bugs is 0, do not say there is a major bug, a critical bug, or a confirmed bug, and do not say "check right away".
  - If outcome is inconclusive or could_not_test, the sentence must include "Our test couldn't complete" and must blame the test, not the site.
  - One or two sentences. No score, no grade.

Fallback wording, if you are unsure: ${run.outcome_detail}`,
      schema: VerdictSchema,
    });
    const parsed = VerdictSchema.parse(raw);
    return { ...run, outcome_detail: alignVerdict(parsed.verdict, facts) };
  } catch {
    return run;
  }
}
