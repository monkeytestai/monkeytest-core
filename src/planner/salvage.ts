/**
 * Keep the usable part of a planner-model response.
 *
 * A strict schema used to reject the whole plan when one flow had an empty
 * `steps` array (`flows[5].steps`). The crawl's form and fault flows then
 * never ran. This pass drops only the broken flows. Callers still append
 * the deterministic grounded flows afterwards.
 */

import { z } from 'zod';
import { coerceEnum } from '../llm/coerce.js';
import type { FlowKind, TestFlow, TestStep } from '../types.js';

const KINDS = ['happy_path', 'edge_case', 'auth_required', 'destructive', 'accessibility', 'visual'] as const;
const SEVERITIES = ['critical', 'major', 'minor'] as const;

const StrictFlowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(3),
  description: z.string().min(3),
  kind: z.enum(KINDS),
  startUrl: z.string().url(),
  steps: z.array(z.object({
    action: z.string().min(3),
    expectation: z.string().optional(),
  })).min(1),
  expectation: z.string().min(3),
  severityIfFails: z.enum(SEVERITIES),
});

export interface SalvagedFlows {
  flows: TestFlow[];
  /** Model flows that had no usable step or start URL. */
  dropped: number;
}

export function salvageModelFlows(raw: unknown): SalvagedFlows {
  const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? [raw] : null);
  if (!list) return { flows: [], dropped: 0 };
  const flows: TestFlow[] = [];
  let dropped = 0;
  list.forEach((item, index) => {
    const flow = coerceFlow(item, index);
    if (flow) flows.push(flow);
    else dropped += 1;
  });
  return { flows, dropped };
}

function coerceFlow(raw: unknown, index: number): TestFlow | undefined {
  const strict = StrictFlowSchema.safeParse(raw);
  if (strict.success) return strict.data;

  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const startUrl = typeof record.startUrl === 'string' ? record.startUrl : '';
  if (!z.string().url().safeParse(startUrl).success) return undefined;
  const steps = usableSteps(record.steps);
  if (steps.length === 0) return undefined;

  return {
    id: text(record.id, 1) || `model-flow-${index + 1}`,
    name: text(record.name, 3) || `Flow ${index + 1}`,
    description: text(record.description, 3) || 'Kept from a partial planner response.',
    kind: coerceEnum(record.kind, KINDS, {
      happy: 'happy_path',
      edge: 'edge_case',
      auth: 'auth_required',
      login: 'auth_required',
      a11y: 'accessibility',
    }) ?? 'happy_path',
    startUrl,
    steps,
    expectation: text(record.expectation, 3) || 'The journey completes.',
    severityIfFails: coerceEnum(record.severityIfFails ?? record.severity, SEVERITIES, {
      high: 'major',
      medium: 'major',
      med: 'major',
      low: 'minor',
      blocker: 'critical',
      severe: 'critical',
    }) ?? 'major',
  };
}

function usableSteps(raw: unknown): TestStep[] {
  const list = Array.isArray(raw)
    ? raw
    : (typeof raw === 'string' || (raw && typeof raw === 'object') ? [raw] : []);
  const steps: TestStep[] = [];
  for (const item of list) {
    if (typeof item === 'string') {
      const action = item.trim();
      if (action.length >= 3) steps.push({ action });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const action = text(record.action, 3) || text(record.instruction, 3) || text(record.step, 3);
    if (action.length < 3) continue;
    const expectation = text(record.expectation, 1) || undefined;
    steps.push(expectation ? { action, expectation } : { action });
  }
  return steps;
}

function text(value: unknown, min: number): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length >= min ? trimmed : '';
}
