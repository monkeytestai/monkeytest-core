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

/**
 * Token accounting for a single completed LLM call, tagged with the model
 * that served it. `LLM.lastUsage` only ever holds the most recent call, so
 * hosts that need a per-run total should collect these instead.
 */
export interface LLMUsageEvent {
  /** Provider and model, eg "openai:gpt-4o-mini". */
  provider: string;
  /** Call site, eg "planner.designFlows". */
  label?: string;
  /** Total input tokens billed for this call (provider-reported). */
  inputTokens?: number;
  /** Of `inputTokens`, how many were served from the prompt cache. */
  cachedInputTokens?: number;
  /** Output / completion tokens. */
  outputTokens?: number;
  /** Whether this call wrote new content into the prompt cache. */
  cacheWrite?: boolean;
}

/** Called once per completed LLM call. Must never throw. */
export type LLMUsageSink = (usage: LLMUsageEvent) => void;

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
  /**
   * Optional callback invoked after every successful call, so a host can sum
   * token spend across a whole run. Pass the same sink to every phase's config
   * to get a single run-wide total.
   */
  onUsage?: LLMUsageSink;
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

/**
 * One control inside a scraped form. Every property is optional because the
 * DOM may only expose some of them. Hosts that only read `SiteMapForm.fields`
 * can ignore this.
 */
export interface SiteMapFormInput {
  /** `name` attribute, when the control has one. */
  name?: string;
  /** Associated label, `aria-label`, or wrapping `<label>` text. */
  label?: string;
  placeholder?: string;
  /** Input type, or `textarea` / `select` when the control has no type. */
  type?: string;
}

/**
 * A `<form>` scraped from the DOM. Absent fields mean the crawler did not
 * see them. Hosts that do not know this type can ignore `SiteMapPage.forms`.
 */
export interface SiteMapForm {
  /** Resolved action URL when the browser provided one. */
  action: string;
  /** Lower-case method, usually `"get"` or `"post"`. */
  method?: string;
  /**
   * Flat field tokens, unchanged for existing readers: `name`, then
   * placeholder, then type. Prefer `inputs` when choosing a locator.
   */
  fields: string[];
  /**
   * Label, name, placeholder, and type for each entry in `fields`, when the
   * crawler could read them. Omitted on older sitemaps. Additive.
   */
  inputs?: SiteMapFormInput[];
  /** Visible label of the submit control, when the form had one. */
  submitLabel?: string;
}

/**
 * A button or link scraped from the DOM. Absent when the crawler did not
 * see the attribute. Hosts that do not know this type can ignore
 * `SiteMapPage.controls`.
 */
export interface SiteMapControl {
  kind: 'button' | 'link';
  /** Visible label, trimmed. */
  label: string;
  /** Absolute href for a link, when the browser resolved one. */
  href?: string;
  /** True when the control is disabled. Omitted when it is enabled. */
  disabled?: boolean;
}

export interface SiteMapPage {
  url: string;
  title: string;
  /** What this page appears to do, in plain English. From the LLM. */
  summary: string;
  /** Salient interactive elements the LLM noticed. */
  interactive: SiteMapInteractive[];
  /** Outgoing in-domain links the explorer found on this page. */
  outboundLinks: string[];
  /**
   * Forms scraped from the DOM. Omitted when the page has none.
   * Additive: existing readers can ignore it.
   */
  forms?: SiteMapForm[];
  /**
   * Buttons and links scraped from the DOM. Omitted when the page has none.
   * Additive: existing readers can ignore it. The planner uses this list to
   * exercise fault surfaces without asking the model to invent controls.
   */
  controls?: SiteMapControl[];
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
  /** Brand / product name if the crawl made it obvious. */
  productName?: string;
  /** Real anonymous-visitor journeys the planner should prefer. */
  publicJourneys?: string[];
  /** Login / signup / OTP surfaces noticed but not entered. */
  authSurfaces?: string[];
  /**
   * User-facing notes when a model response was incomplete and the crawl
   * continued with a fallback. Omitted when every summary parsed. Hosts can
   * show these strings as-is. Technical parser errors are not included.
   */
  warnings?: string[];
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
  /** Stable locator captured for replay (role, name, test id, CSS fallback). */
  locator?: TraceLocator;
  /**
   * `recorded` — the action came from the trace (or the original LLM resolution).
   * `healed` — the recorded locator missed and the LLM re-resolved the step.
   */
  resolution?: TraceResolution;
  /** Wall-clock duration in milliseconds. */
  durationMs?: number;
  /** Console errors that fired while this step was executing. */
  consoleErrors?: ConsoleErrorEvidence[];
  /** Failed network requests recorded during this step. */
  networkFailures?: NetworkFailureEvidence[];
  /** Raw error message when status === 'failed'. */
  error?: string;
}

export type FlowStatus = 'passed' | 'failed' | 'blocked' | 'error' | 'inconclusive';

/**
 * Run-level outcome. Wire names match the SaaS `audit_run` columns.
 *
 * `bugs_found` — one or more confirmed site bugs.
 * `clean` — at least one journey actually ran and no confirmed bugs.
 * `inconclusive` — we reached the site, but did not finish a real check
 * (every step skipped, or the only failures were ours).
 * `could_not_test` — nothing was tested: no pages, no flows, or the site
 * was unreachable, blocked, or not a URL.
 */
export type RunOutcome = 'bugs_found' | 'clean' | 'inconclusive' | 'could_not_test';

/**
 * Short machine code for `outcome_reason`. The first seven are the SaaS
 * examples. `automation_error`, `not_attempted`, and `nothing_tested` are
 * additive codes for cases those examples do not name.
 *
 * `login_required` is used only when a step or page shows a real login wall
 * (a password field, a login form). A flow the planner skipped because it
 * was marked `auth_required` is `not_attempted`.
 */
export type OutcomeReason =
  | 'login_required'
  | 'blocked_by_bot_protection'
  | 'site_unreachable'
  | 'invalid_url'
  | 'llm_error'
  | 'all_flows_skipped'
  | 'timeout'
  | 'automation_error'
  | 'not_attempted'
  | 'nothing_tested';

export interface FlowResult {
  flowId: string;
  name: string;
  description: string;
  kind: FlowKind;
  startUrl: string;
  status: FlowStatus;
  /** Why the flow as a whole failed, if it did. */
  failureReason?: string;
  /**
   * Machine code when this flow did not produce a confirmed bug: skipped,
   * blocked, errored, or inconclusive. Omitted on a flow that passed or
   * that failed with a real site bug. `login_required` is set only when a
   * login wall was actually observed.
   */
  outcome_reason?: OutcomeReason;
  /** Human sentence for this flow, including what to do next. */
  outcome_detail?: string;
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
  /**
   * Resolved actions for this flow, in order, including the opening navigation.
   * `monkeytest rerun` replays this trace without calling the LLM.
   * Absent on runs recorded before trace capture existed.
   */
  trace?: FlowTrace;
}

export interface RunResult {
  startUrl: string;
  startedAt: string;            // ISO timestamp
  finishedAt: string;
  flows: FlowResult[];
  bugs: BugReport[];
  /**
   * SaaS outcome. `bugs_found | clean | inconclusive | could_not_test`.
   * Omitted on runs saved before 0.6.0. `triage()` always sets it.
   */
  outcome?: RunOutcome;
  /** Short machine code. See `OutcomeReason`. Omitted for `clean` and `bugs_found`. */
  outcome_reason?: OutcomeReason;
  /**
   * One or two sentences that agree with `bugs.length`, plus a next step.
   * When the cause is the runner, the sentence says "Our test couldn't complete".
   */
  outcome_detail?: string;
  /** Aggregate stats for quick UI rendering. */
  stats: {
    flowsTotal: number;
    flowsPassed: number;
    flowsFailed: number;
    /** Login / credential flows that were not executed. */
    flowsBlocked: number;
    /** Flows where every step was skipped, or the only failures were ours. */
    flowsInconclusive?: number;
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
  /** Playwright resource type (`document`, `xhr`, `fetch`, …) when the response was observed. */
  resourceType?: string;
}

/* ── Action traces (replay) and v2 fingerprints ───────────────────────── */

export type TraceTool = 'click' | 'fill' | 'goto' | 'wait' | 'assert_text' | 'press' | 'noop';

export type TraceLocatorStrategy = 'role' | 'text' | 'placeholder' | 'label' | 'testid' | 'css';

export type TraceResolution = 'recorded' | 'healed';

/**
 * Everything replay needs to find the same element without asking the LLM.
 * Strategies are tried in stability order: test id, role+name, label,
 * placeholder, text, then the CSS fallback.
 */
export interface TraceLocator {
  strategy: TraceLocatorStrategy;
  /** Primary target recorded with `strategy` (accessible name, text, selector, URL, test id). */
  target: string;
  role?: string;
  name?: string;
  text?: string;
  testId?: string;
  /** Last-resort CSS selector captured from the live element. */
  css?: string;
  placeholder?: string;
  label?: string;
}

export interface TraceStep {
  /** 0 is the opening navigation; planned steps start at 1. */
  index: number;
  /** Natural-language instruction from the plan, when this step came from one. */
  action?: string;
  expectation?: string;
  tool: TraceTool;
  locator?: TraceLocator;
  /** Value typed (fill) or key pressed (press). */
  value?: string;
  /** Page URL before the action. */
  urlBefore?: string;
  /** Page URL after the action. */
  urlAfter?: string;
  /** ISO timestamp when the step started. */
  startedAt?: string;
  durationMs?: number;
  status: StepStatus;
  observation?: string;
  error?: string;
  screenshotPath?: string;
  consoleErrors?: ConsoleErrorEvidence[];
  networkFailures?: NetworkFailureEvidence[];
  /** Absent or `recorded` on the original capture. `healed` is a replay annotation. */
  resolution?: TraceResolution;
}

export interface FlowTrace {
  version: 1;
  flowId: string;
  name: string;
  description?: string;
  kind?: FlowKind;
  startUrl: string;
  expectation?: string;
  steps: TraceStep[];
}

/** Prefix of a flow trace through the failing step, stored on the bug itself. */
export interface BugTrace {
  version: 1;
  flowId: string;
  startUrl: string;
  steps: TraceStep[];
}

/**
 * Inputs to a v2 fingerprint. Stored beside the hash so diff and verify can
 * recompute it, and so a human can see why two bugs did or did not match.
 */
export interface FingerprintParts {
  version: 2;
  /** Oracle that failed. Never an LLM tool name. */
  category: string;
  /** URL template; numeric ids, uuids, and timestamps replaced. */
  location: string;
  /** Accessible role, or empty when the failure is not element-scoped. */
  role: string;
  /** Normalised accessible name. */
  name: string;
  /** Coarse error class. Numbers, ids, and timestamps removed. */
  errorSignal: string;
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
   * Legacy identity. sha1 of action text + tool + a small error code, 16 hex
   * chars. New triage still writes this exact algorithm so bugs already
   * stored by a host (and compared as strings) keep matching. The stable
   * identity is `fingerprintV2`.
   */
  fingerprint: string;
  /**
   * Stable identity: sha1 of `category | location | role | name | errorSignal`.
   * The LLM tool name and raw error text are not inputs. Absent on bugs
   * written before this field existed. See `fingerprintParts`.
   */
  fingerprintV2?: string;
  /** Present on bugs triaged with the v2 scheme. */
  fingerprintParts?: FingerprintParts;
  /**
   * Resolved actions from the start of the flow through the failing step,
   * plus that step's screenshot / console / network evidence when captured.
   */
  trace?: BugTrace;
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
