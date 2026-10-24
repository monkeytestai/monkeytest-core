# Changelog

All notable changes to **MonkeyTest Core** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **SaaS migration.** `new Monkey()` now defaults `strictOracles` and `failOn5xx` to **on**. A page error, a document HTTP 404, a disabled control a step tries to use, and a same-origin HTTP ≥500 (document, xhr, or fetch) become a failed step and a blocking bug. Bug counts and `flowsFailed` will rise. To keep the previous counts, pass `strictOracles: false` and `failOn5xx: false` on the constructor, or the same fields on one `run` / `replay` / `verify` call. `www` and the apex host still match. Other ports, third-party hosts, and image/font responses stay evidence only.
- `runPlan`, `replayTraces`, `verifyBugs`, and `triage(run)` still leave those switches off unless the caller passes them, so triaging a run you already built does not rewrite it. `Monkey` passes the constructor values (now on) into the run and into `triage`. `RunResult` fields are unchanged.
- The planner keeps grounded flows, within `maxFlows`, for a crawled public form, one enabled non-submit button, one same-origin link whose target was not crawled, and one disabled non-submit button. Labels and URLs come from the crawl (`SiteMapPage.controls`, optional). Leftover model flows are the ones replaced when the budget is full.
- The runner performs `Click "Save order"` and `Fill the "email" field` itself when that label is on the page. Other steps still go to the runner model.
- `monkeytest run` exits **3** when the explorer visits zero pages, instead of exiting 0 with an empty report.
- The live e2e script starts the CLI as an asynchronous child. `spawnSync` froze the in-process demo server, the homepage timed out, and the buggy fixture exited 0.

### Added

- `--fail-on-5xx` (CLI default on, `--no-fail-on-5xx` opts out) fails a passed or skipped step that observed a same-origin HTTP ≥500 on a document, xhr, or fetch, and the triager files it as a critical bug. `new Monkey()` now defaults this **on** as well. Pass `failOn5xx: false` to opt out. `www` and the apex host match. Other ports, third-party hosts, and image/font responses stay evidence only.
- The crawler reserves a few `maxPages` slots for help, contact, support, about, and other form-style links it actually saw, and keeps those links even when they sit past the ordinary link cap. `SiteMapPage.forms` records scraped forms (optional; existing readers can ignore it).
- When the crawl contains a public form and `maxFlows` is at least 1, the planner keeps a form-submit flow grounded in that page's URL, fields, and submit label. A header search box does not take that slot. The model is asked for the same flow; the deterministic pass is the floor.
- Action traces on each flow and on each bug (locator, value, URL, timing, evidence).
- `fingerprintV2` and `fingerprintParts` (version 2) from failure category, URL template, element role + name, and a normalised error signal. `fingerprint` stays the legacy v1 hash so stored bugs still match. Diff and verify use v2 only when both sides have it.
- `monkeytest rerun` replays the stored trace with no LLM calls. `--heal` re-resolves a step whose locator missed and marks that step `healed`.
- `monkeytest verify` replays each bug trace and reports `fixed`, `still_broken`, `flaky`, `healed`, or `blocked`. Exit `1` when any bug is `still_broken` or `flaky`.
- Vitest coverage for fingerprints, trace serialisation, verdicts, and `diffRuns`, plus an integration test. CI runs `npm test`.
- Strict oracles fail a step when the page throws, a document returns HTTP 404, an action returns HTTP 5xx, or the clicked control is disabled. They default **on** for `new Monkey()` and for the CLI. Pass `strictOracles: false` to opt out. Replay uses the same switch. `runPlan` still defaults it off unless the caller passes it.
- Reusable buggy/fixed demo app under `test/fixtures/demo-app`. `npm test` covers it with a stub LLM. `.github/workflows/e2e-live.yml` runs the same app with a real model (manual, nightly, and pushes to `main`).

### Fixed

- The per-flow timeout no longer leaves its timer running after the flow finishes, and it closes the browser context when the budget is exceeded.

## [0.4.0] — 2026-05

The bug-finding loop release. The CLI is now a real product surface with
`init`, `run`, `rerun`, `diff`, and `report` subcommands; the engine ships
the primitives those commands stand on (`Monkey.runFromPlan`, `diffRuns`,
plus `savePlan`/`loadPlan`/`saveRun`/`loadRun`).

### Added

- `Monkey.runFromPlan(plan, opts)` — re-execute a stored `TestPlan`
  without re-crawling or re-planning. The deterministic, cheap path for
  verifying that a fix actually landed.
- `diffRuns(prev, current)` — set diff over `BugReport.fingerprint`s plus
  a severity-rank check. Returns `{ newBugs, fixedBugs, persistingBugs,
  regressedBugs, stats }`. `summariseDiff()` for one-line CLI output.
- Persistence module: `savePlan` / `loadPlan` / `saveRun` / `loadRun` /
  `listRuns` with versioned `schema` field. Stable on-disk layout under
  `.monkeytest/{plan.json, runs/<id>.json, shots/}`.
- New CLI subcommands:
  - `monkeytest init` — scaffold `.monkeytest/`.
  - `monkeytest run <url>` — full pipeline + persisted plan + run.
  - `monkeytest rerun [<runId>]` — re-execute the same stored plan.
  - `monkeytest diff <runA> <runB>` — bug-fingerprint diff with shortcuts
    `latest`/`prev`. Exits `1` on new bugs or severity escalations.
  - `monkeytest report [<runId>]` — pretty-print a stored run.
- Consistent CLI exit codes (`0` ok, `1` bugs/regressions, `2` bad args,
  `3` engine error) so CI can gate on results.

### Changed

- CLI rewritten as a subcommand router with per-command help; old
  single-command entrypoint deprecated but `explore` still works.
- Plan / run JSON gain a `schema: 1` field for forwards-compatibility.

### Docs

- New guide: **The bug-finding loop** — explains the find-fix-rerun-diff
  cycle and the SaaS variant.
- New reference page: **CLI** with every subcommand, flag, env var, exit
  code, and the on-disk layout.
- Homepage and README updated to lead with the loop story.

## [0.3.0] — 2026-05

First public npm release.

### Added

- **Anthropic Claude** provider (`provider: 'anthropic'`) with full
  `messages.create` integration and prompted JSON mode.
- **Mistral** provider (`provider: 'mistral'`) using native
  `responseFormat: { type: 'json_object' }`.
- **Groq** provider (`provider: 'groq'`) routing through Groq's
  OpenAI-compatible endpoint for low-latency runner calls.
- **OpenAI-compatible** provider (`provider: 'openai_compatible'`) with
  `baseURL` for Ollama, vLLM, LM Studio, OpenRouter, Together, and any
  other server speaking the OpenAI Chat Completions wire format. JSON mode
  is auto-disabled for `localhost`/`127.0.0.1` endpoints.
- **Per-phase LLM tiers.** `MonkeyLLMConfig` now exposes a dedicated
  `runner?: LLMConfig` slot so the hot-path per-step calls can use a cheap,
  fast model while the planner uses a smarter one.
- **Optional triager polish pass.** Set `MonkeyConfig.llm.triager` to have
  the engine rewrite each bug's `title`, `observed`, `expected`, and
  `triageNotes` from the structured evidence the deterministic triager
  already collected. Per-bug try/catch — a bad LLM response on one bug
  never affects the others, and the deterministic copy is always preserved
  on failure.
- **Prompt caching** for OpenAI (auto, prompt-prefix) and Anthropic
  (`cache_control: { type: 'ephemeral' }` breakpoints on the system block
  and the long stable user block). The planner prompt is restructured into
  `system` + `cacheable` (site map) + `prompt` (per-call constraints) so
  repeat runs against the same site reuse the cached prefix.
- **`LLM.lastUsage`** — token + cache stats from each call
  (`inputTokens`, `cachedInputTokens`, `outputTokens`, `cacheWrite`).
  Surfaced through the `plan.complete` / `triage.complete` events so SaaS
  dashboards can render "saved $X via prompt cache".
- **`autoLLMConfig({ quality })`** ergonomic helper — auto-detects a
  provider from env vars and applies `cheap` / `balanced` / `smart`
  presets. Lets users start in two lines.
- **`detectProviderFromEnv`**, **`CHEAP_FAST_MODEL`**, **`SMART_MODEL`**
  exports for advanced consumers.

### Changed

- Planner prompt restructured for cache friendliness; identical behaviour
  for callers using `Monkey` directly.
- Default Gemini model remains `gemini-flash-lite-latest`. Default OpenAI
  model remains `gpt-4o-mini`. Anthropic defaults to `claude-haiku-4-5`,
  Mistral to `mistral-small-latest`, Groq to `llama-3.3-70b-versatile`.
- `triage()` is unchanged and remains zero-LLM-cost. The new
  `triagePolished()` is a separate async export for callers that want to
  drive the polish pass directly.

### Documentation

- New comprehensive docs site at **docs.monkeytest.ai** with sections:
  Architecture, LLM providers, Cost & depth, Prompt caching, Triager
  polish, Recipes, Use in CI, Troubleshooting.
- Hero image and value-led README.

## [0.2.0] — 2026

### Added

- Explorer, planner, runner, triager pipeline
- Playwright execution with per-step screenshots and optional flow video
- `EventBus` for live activity streams
- OpenAI and Gemini LLM backends

[0.3.0]: https://github.com/monkeytestai/monkeytest-core/releases/tag/v0.3.0
[0.2.0]: https://github.com/monkeytestai/monkeytest-core/releases/tag/v0.2.0
