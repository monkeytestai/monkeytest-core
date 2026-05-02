/**
 * Public, stable type contracts that flow between phases of the engine and
 * out to consumers (the runner HTTP service, the SaaS server, the CLI).
 *
 * Anything exported from this file is part of the engine's public API — keep
 * it small and intentional. Internal-only types live next to the code that
 * uses them.
 */

/* ── LLM configuration ────────────────────────────────────────────────── */

export type LLMProvider =
  | 'openai'
  | 'gemini'
  | 'anthropic'
  | 'mistral'
  | 'groq'
  | 'openai_compatible';

export interface LLMConfig {
  provider: LLMProvider;
  model?: string;
  apiKey?: string;
  /**
   * Optional base URL for self-hosted or OpenAI-compatible endpoints
   * (Ollama, LM Studio, vLLM, OpenRouter, Groq, Together, …). Used by the
   * `openai_compatible` provider; ignored by hosted providers.
   */
  baseURL?: string;
  /** Sampling temperature override (default 0.2 — JSON tasks). */
  temperature?: number;
}

/**
 * Tiered LLM configuration. Each phase can use a different provider/model so
 * teams can mix a cheap model for the chatty crawl phase with a smarter model
 * for planning, and a fast/cheap model again for per-step tool resolution.
 *
 *   - `explorer` — per-page summaries (high call volume; cheap is fine)
 *   - `planner`  — single high-stakes call to design the test flows (use the
 *                  smartest tier you can afford)
 *   - `runner`   — per-step "what tool should I call?" decisions (call volume
 *                  scales with steps; cheap is fine)
 *   - `triager`  — optional LLM polish pass that rewrites bug titles,
 *                  observed/expected wording, and triage notes from the
 *                  evidence the rule-based triager already collected. Cheap
 *                  and resilient (per-bug try/catch with deterministic
 *                  fallback). Set this when you want human-readable bug copy.
 *
 * Omit `runner` and the engine reuses `planner` (back-compat). Omit `triager`
 * and the engine uses the rule-based triager only (zero extra LLM cost).
 */
export interface MonkeyLLMConfig {
  explorer: LLMConfig;
  planner: LLMConfig;
  runner?: LLMConfig;
  triager?: LLMConfig;
}

/* ── SiteMap (output of Explorer) ─────────────────────────────────────── */

export interface SiteMapPage {
  url: string;
  title: string;
  /** What this page appears to do, in plain English. From the LLM. */
  summary: string;
  /** Salient interactive elements the LLM noticed. */
  interactive: SiteMapInteractive[];
  /** Outgoing in-domain links the explorer found on this page. */
  outboundLinks: string[];
  /** Whether the page seems to require authentication. */
  authGated: boolean;
  /** Absolute path to the screenshot taken of this page, if requested. */
  screenshotPath?: string;
}

export interface SiteMapInteractive {
  kind: 'form' | 'button' | 'link' | 'input' | 'menu';
  label: string;
  /** A best-effort selector the runner can use later. Optional. */
  selector?: string;
}

export interface SiteMap {
  startUrl: string;
  /** Inferred site type — e.g. "saas dashboard", "ecommerce", "blog". */
  siteType: string;
  /** One-paragraph plain-English description of the whole site. */
  summary: string;
  pages: SiteMapPage[];
  /** Pages the explorer noticed but did not actually visit. */
  pendingUrls: string[];
  /** Pages where the crawler hit auth walls / errors. */
  failedUrls: { url: string; reason: string }[];
}

/* ── TestPlan (output of Planner) ─────────────────────────────────────── */

export type FlowKind =
  | 'happy_path'
  | 'edge_case'
  | 'auth_required'
  | 'destructive'
  | 'accessibility'
  | 'visual';

export interface TestStep {
  /** Human-readable instruction the runner / agent should perform. */
  action: string;
  /** What the user expects to see / what the test is asserting. */
  expectation?: string;
}

export interface TestFlow {
  id: string;
  name: string;
  description: string;
  kind: FlowKind;
  /** Suggested starting URL — usually one from the SiteMap. */
  startUrl: string;
  steps: TestStep[];
  /** Single-sentence success criterion for the whole flow. */
  expectation: string;
  /** Estimated risk if this fails for a real user. */
  severityIfFails: 'critical' | 'major' | 'minor';
}

export interface TestPlan {
  startUrl: string;
  siteType: string;
  flows: TestFlow[];
  /** Free-form notes from the planner — caveats, scoping decisions, etc. */
  notes?: string;
}

/* ── Run results (output of Runner) ───────────────────────────────────── */

/**
 * Outcome of a single step within a flow execution.
 *
 * `passed`  — the step ran and the assertion (or implicit "didn't crash")
 *             succeeded.
 * `failed`  — the step ran but produced a clear bug — selector missing,
 *             page error, network failure on a critical request, etc.
 * `blocked` — the step couldn't be attempted because a previous step failed
 *             (we still record it so the timeline reads cleanly).
 * `skipped` — the planner asked us to do something we can't safely automate
 *             (real signups, payments, …).
 */
export type StepStatus = 'passed' | 'failed' | 'blocked' | 'skipped';

export interface StepResult {
  /** 1-indexed position of this step in the flow. */
  index: number;
  /** Verbatim instruction from the plan. */
  action: string;
  /** Optional expectation from the plan. */
  expectation?: string;
  status: StepStatus;
  /** Plain-English description of what actually happened. */
  observation: string;
  /** Absolute path to the screenshot taken AFTER attempting this step. */
  screenshotPath?: string;
  /** Concrete tool the runner used: 'goto' | 'click' | 'fill' | … */
  tool?: string;
  /** Selector (or URL/value) the tool acted on, for the report timeline. */
  target?: string;
  /** Wall-clock duration in milliseconds. */
  durationMs?: number;
  /** Console errors that fired while this step was executing. */
  consoleErrors?: ConsoleErrorEvidence[];
  /** Failed network requests recorded during this step. */
  networkFailures?: NetworkFailureEvidence[];
  /** Raw error message when status === 'failed'. */
  error?: string;
}

export type FlowStatus = 'passed' | 'failed' | 'blocked' | 'error';

export interface FlowResult {
  flowId: string;
  name: string;
  description: string;
  kind: FlowKind;
  startUrl: string;
  status: FlowStatus;
  /** Why the flow as a whole failed, if it did. */
  failureReason?: string;
  steps: StepResult[];
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** BugReport ids that were produced from this flow. */
  bugIds: string[];
  /**
   * Absolute path to the WebM screen recording for this flow. Playwright
   * records the entire browser context from first navigation to context.close().
   * The file is renamed to a predictable name after the flow finishes so the
   * server can serve it without a manifest.
   */
  videoPath?: string;
}

export interface RunResult {
  startUrl: string;
  startedAt: string;            // ISO timestamp
  finishedAt: string;
  flows: FlowResult[];
  bugs: BugReport[];
  /** Aggregate stats for quick UI rendering. */
  stats: {
    flowsTotal: number;
    flowsPassed: number;
    flowsFailed: number;
    stepsTotal: number;
    stepsPassed: number;
    stepsFailed: number;
    bugsCritical: number;
    bugsMajor: number;
    bugsMinor: number;
  };
}

/* ── BugReport (output of Triager) ────────────────────────────────────── */

export interface ConsoleErrorEvidence {
  message: string;
  level: 'error' | 'warning';
  url?: string;
  lineNumber?: number;
}

export interface NetworkFailureEvidence {
  url: string;
  method: string;
  status?: number;
  failureText?: string;
}

export interface BugEvidence {
  screenshots: string[];
  consoleErrors: ConsoleErrorEvidence[];
  networkFailures: NetworkFailureEvidence[];
  /** A trimmed DOM snapshot at the point of failure, if available. */
  domSnapshot?: string;
}

export interface BugReport {
  id: string;
  /**
   * Stable hash across runs so "fixed" / "regressed" become real concepts.
   * Derived from (affectedFlow, normalised observation, primary error code).
   */
  fingerprint: string;
  title: string;
  severity: 'critical' | 'major' | 'minor';
  affectedFlow: string;
  reproSteps: string[];
  observed: string;
  expected: string;
  evidence: BugEvidence;
  /** 1–3 sentence explanation from the triager LLM. */
  triageNotes: string;
}

/* ── Live event stream (yielded by Monkey.run) ────────────────────────── */

export type MonkeyEvent =
  | { type: 'explore.start'; url: string }
  | { type: 'explore.page'; page: SiteMapPage }
  | { type: 'explore.complete'; siteMap: SiteMap }
  | { type: 'plan.start' }
  | { type: 'plan.complete'; plan: TestPlan }
  | { type: 'flow.start'; flow: TestFlow }
  | { type: 'step.start'; flowId: string; index: number; step: TestStep }
  | { type: 'step.screenshot'; flowId: string; index: number; path: string }
  | { type: 'step.console_error'; flowId: string; index: number; error: ConsoleErrorEvidence }
  | { type: 'step.network_failure'; flowId: string; index: number; failure: NetworkFailureEvidence }
  | { type: 'step.complete'; flowId: string; index: number; ok: boolean; details?: string }
  | { type: 'flow.complete'; flowId: string; ok: boolean }
  | { type: 'bug.discovered'; bug: BugReport }
  | { type: 'run.complete'; bugs: BugReport[] }
  | { type: 'error'; phase: string; message: string };
