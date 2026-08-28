/**
 * Public entry point for @mtai/monkeytest-core.
 *
 * Consumers should import from here, not from internal subpaths, so we have
 * room to refactor the internals.
 */

export { Monkey } from './monkey.js';
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

export { plan } from './planner/index.js';
export type { PlannerOptions } from './planner/index.js';

export { runPlan } from './runner/index.js';
export type { RunnerOptions, RunnerEvent } from './runner/index.js';

export { triage, triagePolished } from './triager/index.js';
export type { TriageOptions } from './triager/index.js';

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
  ConsoleErrorEvidence,
  NetworkFailureEvidence,
  MonkeyEvent,
} from './types.js';
