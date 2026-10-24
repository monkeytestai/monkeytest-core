/**
 * Public entry point for @mtai/monkeytest-core.
 *
 * Consumers should import from here, not from internal subpaths, so we have
 * room to refactor the internals.
 */

export { Monkey, resolveMonkeyOracles } from './monkey.js';
export type {
  MonkeyConfig,
  ExploreAndPlanOptions,
  ExecuteOptions,
  ExecuteFromPlanOptions,
} from './monkey.js';

export { diffRuns, summariseDiff } from './diff/index.js';
export type {
  RunDiff,
  BugDiffEntry,
  RunDiffStatus,
} from './diff/index.js';

export {
  savePlan,
  loadPlan,
  saveRun,
  loadRun,
  listRuns,
  PLAN_FILE_SCHEMA,
  RUN_FILE_SCHEMA,
} from './persistence/index.js';
export type { StoredPlan, StoredRun } from './persistence/index.js';

export { explore } from './explorer/index.js';
export type { ExploreOptions } from './explorer/index.js';

export { plan, groundedTestPlan } from './planner/index.js';
export type { PlannerOptions } from './planner/index.js';

export { runPlan } from './runner/index.js';
export type { RunnerOptions, RunnerEvent } from './runner/index.js';

export { replayTraces } from './runner/replay.js';
export type { ReplayOptions } from './runner/replay.js';

export { verifyBugs, aggregateVerdict, classifyAttempt, verifyExitCode } from './verify/index.js';
export type { VerifyOptions, VerifyReport, BugVerdict, VerifyAttempt, VerifyVerdict } from './verify/index.js';

export { triage, triagePolished } from './triager/index.js';
export type { TriageOptions } from './triager/index.js';

export { bugFingerprint, bugMatchesFingerprint } from './diff/index.js';

export {
  fingerprintFailure,
  fingerprintFromParts,
  legacyFingerprint,
  normaliseErrorSignal,
  normaliseLocation,
  normaliseLabel,
  failureCategory,
} from './trace/fingerprint.js';
export type { FingerprintInput } from './trace/fingerprint.js';

export { serializeTrace, serializeTraceStep, bugTracePrefix } from './trace/serialize.js';

export { createLLM } from './llm/index.js';
export type { LLM, GenerateJSONOptions, LLMUsage } from './llm/index.js';

export {
  autoLLMConfig,
  detectProviderFromEnv,
  CHEAP_FAST_MODEL,
  SMART_MODEL,
} from './llm/presets.js';
export type { AutoLLMOptions } from './llm/presets.js';

export { EventBus, noopBus } from './events.js';
export type { LiveEvent, LiveEventType, LiveEventListener, LivePhase } from './events.js';

export type {
  LLMProvider,
  LLMConfig,
  LLMUsageEvent,
  LLMUsageSink,
  MonkeyLLMConfig,
  SiteMap,
  SiteMapPage,
  SiteMapForm,
  SiteMapControl,
  SiteMapInteractive,
  TestPlan,
  TestFlow,
  TestStep,
  FlowKind,
  StepResult,
  StepStatus,
  FlowResult,
  FlowStatus,
  RunResult,
  BugReport,
  BugEvidence,
  BugTrace,
  FlowTrace,
  TraceStep,
  TraceLocator,
  TraceTool,
  TraceLocatorStrategy,
  TraceResolution,
  FingerprintParts,
  ConsoleErrorEvidence,
  NetworkFailureEvidence,
  MonkeyEvent,
} from './types.js';
