/**
 * Flow status from the steps that actually ran.
 *
 * A flow whose planned steps were all skipped did not pass. Callers still
 * pass `failed` when a step failed so a real product failure stays `failed`.
 */

import type { FlowStatus, StepResult } from '../types.js';

export function resolveFlowStatus(steps: StepResult[], failed = false): Extract<FlowStatus, 'passed' | 'failed' | 'inconclusive'> {
  if (failed || steps.some(step => step.status === 'failed')) return 'failed';
  const planned = steps.filter(step => step.index > 0);
  const body = planned.length > 0 ? planned : steps;
  if (body.length > 0 && body.every(step => step.status === 'skipped')) return 'inconclusive';
  return 'passed';
}
