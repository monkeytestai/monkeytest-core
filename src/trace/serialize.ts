/**
 * Stable JSON shape for action traces stored on runs and bugs.
 *
 * `JSON.stringify` already drops `undefined`, but callers (and tests) want a
 * single place that also drops empty strings, rounds durations, and writes
 * locator keys in a fixed order so two captures of the same action compare
 * equal.
 */

import type { BugTrace, FlowTrace, TraceLocator, TraceStep } from '../types.js';

const TRACE_VERSION = 1 as const;

const LOCATOR_KEYS = [
  'role', 'name', 'text', 'testId', 'css', 'placeholder', 'label',
] as const;

export function serializeLocator(locator: TraceLocator): TraceLocator {
  const out: TraceLocator = {
    strategy: locator.strategy,
    target: locator.target,
  };
  for (const key of LOCATOR_KEYS){
    const value = locator[key];
    if (typeof value === 'string' && value.length > 0){
      out[key] = value;
    }
  }
  return out;
}

export function serializeTraceStep(step: TraceStep): TraceStep {
  const out: TraceStep = {
    index: step.index,
    tool: step.tool,
    status: step.status,
  };
  if (step.action) out.action = step.action;
  if (step.expectation) out.expectation = step.expectation;
  if (step.locator) out.locator = serializeLocator(step.locator);
  if (step.value !== undefined) out.value = step.value;
  if (step.urlBefore) out.urlBefore = step.urlBefore;
  if (step.urlAfter) out.urlAfter = step.urlAfter;
  if (step.startedAt) out.startedAt = step.startedAt;
  if (typeof step.durationMs === 'number' && Number.isFinite(step.durationMs)){
    out.durationMs = Math.max(0, Math.round(step.durationMs));
  }
  if (step.observation) out.observation = step.observation;
  if (step.error) out.error = step.error;
  if (step.screenshotPath) out.screenshotPath = step.screenshotPath;
  if (step.consoleErrors?.length) out.consoleErrors = step.consoleErrors.map(c => ({ ...c }));
  if (step.networkFailures?.length) out.networkFailures = step.networkFailures.map(n => ({ ...n }));
  if (step.resolution) out.resolution = step.resolution;
  return out;
}

export function serializeTrace(trace: FlowTrace): FlowTrace {
  return {
    version: TRACE_VERSION,
    flowId: trace.flowId,
    name: trace.name,
    startUrl: trace.startUrl,
    ...(trace.description ? { description: trace.description } : {}),
    ...(trace.kind ? { kind: trace.kind } : {}),
    ...(trace.expectation ? { expectation: trace.expectation } : {}),
    steps: trace.steps.map(serializeTraceStep),
  };
}

/** Inclusive prefix of a flow trace through the step that failed. */
export function bugTracePrefix(trace: FlowTrace, failingIndex: number): BugTrace {
  return {
    version: TRACE_VERSION,
    flowId: trace.flowId,
    startUrl: trace.startUrl,
    steps: trace.steps
      .filter(step => step.index <= failingIndex)
      .map(serializeTraceStep),
  };
}
