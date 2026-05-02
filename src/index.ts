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
} from './monkey.js';

export { explore } from './explorer/index.js';
export type { ExploreOptions } from './explorer/index.js';

export { plan } from './planner/index.js';
export type { PlannerOptions } from './planner/index.js';

export { runPlan } from './runner/index.js';
export type { RunnerOptions, RunnerEvent } from './runner/index.js';

export { triage } from './triager/index.js';

export { createLLM } from './llm/index.js';
export type { LLM, GenerateJSONOptions } from './llm/index.js';

export { EventBus, noopBus } from './events.js';
export type { LiveEvent, LiveEventType, LiveEventListener, LivePhase } from './events.js';

export type {
  LLMProvider,
  LLMConfig,
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
