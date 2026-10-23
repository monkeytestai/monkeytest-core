# Changelog

All notable changes to **MonkeyTest Core** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Action traces on each flow and on each bug (locator, value, URL, timing, evidence).
- v2 bug fingerprints from failure category, URL template, element role + name, and a normalised error signal. The LLM tool choice and raw error text are not part of the hash.
- `monkeytest rerun` replays the stored trace with no LLM calls. `--heal` re-resolves a step whose locator missed and marks that step `healed`.
- `monkeytest verify` replays each bug trace and reports `fixed`, `still_broken`, `flaky`, `healed`, or `blocked`. Exit `1` when any bug is `still_broken` or `flaky`.
- Vitest coverage for fingerprints, trace serialisation, verdicts, and `diffRuns`, plus an integration test. CI runs `npm test`.
- Product oracles fail a step when the page throws, a document returns HTTP 404, an action returns HTTP 5xx, or the clicked control is disabled. Replay uses the same oracles.
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
