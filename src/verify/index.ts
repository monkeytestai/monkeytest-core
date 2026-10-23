/**
 * Replay each known bug's trace and decide whether it is fixed.
 *
 * The default path never calls an LLM. Pass `heal: true` plus an `llm` to
 * re-resolve a step whose recorded locator no longer matches; that attempt
 * is marked `healed` when the original failure does not come back.
 */

import { chromium, type Browser } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BugReport, BugTrace, FlowTrace, RunResult } from '../types.js';
import { bugMatchesFingerprint } from '../diff/index.js';
import { replayTraces, type ReplayOptions } from '../runner/replay.js';
import {
  aggregateVerdict,
  classifyAttempt,
  verifyExitCode,
  type VerifyAttempt,
  type VerifyVerdict,
} from './verdict.js';

export interface VerifyOptions extends ReplayOptions {
  /** How many times to replay each bug. Default 1. */
  repeat?: number;
  /** When set, only bugs with these fingerprints are checked. */
  fingerprints?: string[];
  /** Explicit bug list. Defaults to `run.bugs` (after the fingerprint filter). */
  bugs?: BugReport[];
}

export interface BugVerdict {
  /** Legacy v1 hash. Hosts that stored `bug.fingerprint` can keep comparing it. */
  fingerprint: string;
  /** Stable hash when the bug was triaged with v2. */
  fingerprintV2?: string;
  bugId: string;
  title: string;
  severity: BugReport['severity'];
  verdict: VerifyVerdict;
  attempts: VerifyAttempt[];
  /** How many attempts reproduced the bug. */
  fired: number;
  repeat: number;
  detail: string;
}

export interface VerifyReport {
  repeat: number;
  heal: boolean;
  results: BugVerdict[];
  stats: {
    total: number;
    fixed: number;
    still_broken: number;
    flaky: number;
    healed: number;
    blocked: number;
  };
  /** 1 when any bug is `still_broken` or `flaky`; otherwise 0. */
  exitCode: 0 | 1;
}

export async function verifyBugs(run: RunResult, opts: VerifyOptions): Promise<VerifyReport> {
  const repeat = opts.repeat ?? 1;
  if (!Number.isInteger(repeat) || repeat < 1){
    throw new Error(`verify repeat must be a positive integer (got ${repeat})`);
  }

  const wanted = opts.fingerprints ? new Set(opts.fingerprints) : undefined;
  const bugs = (opts.bugs ?? run.bugs).filter(bug => !wanted || [...wanted].some(fp => bugMatchesFingerprint(bug, fp)));

  const screenshotsDir = resolve(opts.screenshotsDir);
  mkdirSync(screenshotsDir, { recursive: true });

  const results: BugVerdict[] = [];
  const needsBrowser = bugs.some(bug => (bug.trace?.steps.length ?? 0) > 0);
  const browser = needsBrowser
    ? (opts.browser ?? await chromium.launch({ headless: opts.headless ?? true }))
    : undefined;
  const ownsBrowser = needsBrowser && !opts.browser;

  try {
    for (const bug of bugs){
      results.push(await verifyOne(run, bug, { ...opts, screenshotsDir, browser }, repeat));
    }
  } finally {
    if (ownsBrowser) await browser?.close().catch(() => {});
  }

  const stats = {
    total: results.length,
    fixed: results.filter(r => r.verdict === 'fixed').length,
    still_broken: results.filter(r => r.verdict === 'still_broken').length,
    flaky: results.filter(r => r.verdict === 'flaky').length,
    healed: results.filter(r => r.verdict === 'healed').length,
    blocked: results.filter(r => r.verdict === 'blocked').length,
  };
  const report: VerifyReport = {
    repeat,
    heal: opts.heal === true,
    results,
    stats,
    exitCode: 0,
  };
  report.exitCode = verifyExitCode(report);
  return report;
}

async function verifyOne(
  run: RunResult,
  bug: BugReport,
  opts: VerifyOptions & { browser?: Browser },
  repeat: number,
): Promise<BugVerdict> {
  const base = {
    fingerprint: bug.fingerprint,
    fingerprintV2: bug.fingerprintV2,
    bugId: bug.id,
    title: bug.title,
    severity: bug.severity,
    repeat,
  };

  const trace = flowTraceForBug(run, bug);
  if (!trace){
    const attempts = Array.from({ length: repeat }, () => 'blocked' as const);
    return {
      ...base,
      verdict: 'blocked',
      attempts,
      fired: 0,
      detail: 'No trace was recorded for this bug (run predates trace capture, or the failure had no resolved actions).',
    };
  }

  const failingIndex = trace.steps[trace.steps.length - 1]?.index ?? 0;
  const attempts: VerifyAttempt[] = [];
  const details: string[] = [];

  for (let n = 0; n < repeat; n++){
    const replayed = await replayTraces([trace], { ...opts, recordVideo: opts.recordVideo ?? false });
    const flow = replayed.flows[0];
    const steps = flow?.trace?.steps?.length ? flow.trace.steps : (flow ? stepsFromResults(flow) : []);
    if (!flow || flow.status === 'error' && steps.length === 0){
      attempts.push('blocked');
      details.push(flow?.failureReason || 'Replay failed before any step.');
      continue;
    }
    const classified = classifyAttempt(steps, failingIndex);
    attempts.push(classified.outcome);
    details.push(classified.detail);
  }

  const verdict = aggregateVerdict(attempts);
  const fired = attempts.filter(attempt => attempt === 'still_broken').length;
  return {
    ...base,
    verdict,
    attempts,
    fired,
    detail: summariseDetails(verdict, details),
  };
}

function flowTraceForBug(run: RunResult, bug: BugReport): FlowTrace | undefined {
  const prefix: BugTrace | undefined = bug.trace;
  if (!prefix || prefix.steps.length === 0) return undefined;
  const flow = run.flows.find(item => item.flowId === prefix.flowId);
  return {
    version: 1,
    flowId: prefix.flowId,
    name: flow?.name || bug.affectedFlow || prefix.flowId,
    description: flow?.description,
    kind: flow?.kind,
    startUrl: prefix.startUrl || flow?.startUrl || run.startUrl,
    expectation: flow?.trace?.expectation,
    steps: prefix.steps,
  };
}

function stepsFromResults(flow: { steps: { index: number; action: string; expectation?: string; status: TraceStepStatus; observation: string; tool?: string; error?: string; resolution?: 'recorded' | 'healed'; durationMs?: number }[] }): FlowTrace['steps'] {
  return flow.steps.map(step => ({
    index: step.index,
    action: step.action,
    expectation: step.expectation,
    tool: (step.tool || 'noop') as FlowTrace['steps'][number]['tool'],
    status: step.status,
    observation: step.observation,
    error: step.error,
    durationMs: step.durationMs,
    resolution: step.resolution,
  }));
}

type TraceStepStatus = FlowTrace['steps'][number]['status'];

function summariseDetails(verdict: VerifyVerdict, details: string[]): string {
  const unique = [...new Set(details.filter(Boolean))];
  if (unique.length === 0) return verdict;
  if (unique.length === 1) return unique[0];
  return unique.map((detail, i) => `#${i + 1} ${detail}`).join(' ');
}

export { aggregateVerdict, classifyAttempt, verifyExitCode };
export type { VerifyAttempt, VerifyVerdict };
