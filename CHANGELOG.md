# Changelog

All notable changes to **monkeytester** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] — 2026-10-30

### Added

- Run outcome fields on `RunResult`, set by `triage()`: `outcome` (`bugs_found` | `clean` | `inconclusive` | `could_not_test`), `outcome_reason` (machine code), and `outcome_detail` (a sentence plus a next step). The names match the SaaS `audit_run` columns. `could_not_test` means nothing was tested (no pages, no flows, or the site was unreachable). `login_required` is used only when a login wall was actually seen.
- Per-flow `outcome_reason` and `outcome_detail`. Flow status `inconclusive` means every planned step was skipped, or the only failures were the runner's. `stats.flowsInconclusive` counts those flows. Existing statuses keep their meaning.
- `AUTOMATION_FAULT_SIGNATURES`, `isAutomationFault`, `isOwnAutomationBug`, and `matchesClientSoftExploratory`. These are the Playwright and exploratory misses that must not become confirmed bugs. The list is a superset of mtaiclient `confirmedBugs.js`. A host can import it instead of copying the signatures.
- `alignVerdict` / `verdictContradicts`. An optional `planner.verdict` LLM sentence is kept only when it agrees with the filtered bug count. "Worked smoothly" beside a bug, or "major bug" with zero bugs, is replaced by the deterministic `outcome_detail`. When the cause is the runner, the sentence says "Our test couldn't complete".
- Quick pass depth preset. Id `basic`, label "Quick pass": 6 pages, 4 flows, planner focus `forms-search-cta`. CLI `--depth basic` (alias `--depth quick-pass`). `resolveDepthPreset` and `DEPTH_PRESETS` are the same table (`standard`, `deep`, `shallow` included). An explicit `--max` or `--flows` still wins.
- `valueForInput` / `numericText`. Number and tel fields get digits. `555-0100` typed at a number input becomes `5550100`.

### Fixed

- The runner no longer types `555-0100` into `input[type=number]`. Playwright's "Cannot type text into input" error is classified inconclusive, not a High bug.
- Playwright and selector failures (not an `<input>`, InvalidSelector, strict mode, detached nodes, element not found, selector timeouts, and the mtaiclient soft-timeout and page-title rules) are inconclusive. HTTP 5xx, uncaught page errors, disabled controls, and document HTTP 404 are still bugs. Fingerprints for those real bugs are unchanged.
- A flow whose every step was skipped is `inconclusive`, not `passed`.

### Changed

- `new Monkey()` asks the planner model for a one-line verdict and then runs `alignVerdict`. A model failure leaves the deterministic sentence in place. `triage()` itself stays synchronous and does not call a model.

## Notes recorded before 0.6.0

The notes below were already in the tree before 0.6.0 and describe behaviour shipped in 0.5.x.

### Changed

- README and the docs installed from npm as `npm install @monkeytestai/monkeytest-core` (published 0.4.0). A clone remained the contributor path, including the no-key smoke script. 0.5.0 renames that package to `@monkeytestai/monkeytester`.
- The 0.4.0 package name was `@monkeytestai/monkeytest-core` (it was `@mtai/monkeytest-core`; that npm scope is taken). Imports, install docs, CI, and the Docker image used that name. Runtime behavior and the AGPL-3.0 license were unchanged. 0.5.0 replaces it.
- **SaaS migration.** `new Monkey()` now defaults `strictOracles` and `failOn5xx` to **on**. A page error, a document HTTP 404, a disabled control a step tries to use, and a same-origin HTTP ≥500 (document, xhr, or fetch) become a failed step and a blocking bug. Bug counts and `flowsFailed` will rise. To keep the previous counts, pass `strictOracles: false` and `failOn5xx: false` on the constructor, or the same fields on one `run` / `replay` / `verify` call. `www` and the apex host still match. Other ports, third-party hosts, and image/font responses stay evidence only.
- `runPlan`, `replayTraces`, `verifyBugs`, and `triage(run)` still leave those switches off unless the caller passes them, so triaging a run you already built does not rewrite it. `Monkey` passes the constructor values (now on) into the run and into `triage`. `RunResult` fields are unchanged.
- The planner keeps grounded flows, within `maxFlows`, for a crawled public form, one enabled non-submit button, one same-origin link whose target was not crawled, and one disabled non-submit button. Labels and URLs come from the crawl (`SiteMapPage.controls`, optional). Leftover model flows are the ones replaced when the budget is full.
- The runner performs `Click "Save order"` and `Fill the "email" field` itself when that label is on the page. Other steps still go to the runner model.
- `monkeytest run` exits **3** when the explorer visits zero pages, instead of exiting 0 with an empty report.
- The live e2e script starts the CLI as an asynchronous child. `spawnSync` froze the in-process demo server, the homepage timed out, and the buggy fixture exited 0.

### Added

- Multi-stage `Dockerfile` (Node 22, `bookworm-slim`) and [DOCKER.md](./DOCKER.md). `npm ci` and `npm run build` produced `/opt/monkeytest-core` (`dist/`, `package.json`, license files, production dependencies) for a `file:` install or `COPY --from`. 0.5.0 moves that tree to `/opt/monkeytester`. Playwright browsers are not downloaded. Engine audit behavior is unchanged.
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

- The release workflow grants `contents: write` so it can open the GitHub release after npm publish. Provenance still uses `id-token: write`. The release install command uses the package version with the leading `v` removed.
- A valid planner response can no longer drop a public form the crawl already saw. The form-submit flow is a reserved slot: shopping-only plans, and plans whose only submit is a vague "submit" on that page, still include the grounded flow and its action URL (for example `/api/contact`). Fault-surface flows cannot take that slot. Help, contact, and about reads are dropped only after shop flows. `SiteMapForm.inputs` optionally records label, name, placeholder, and type; `fields` is unchanged. Fill steps use that label, then a `name` CSS selector, instead of an invented placeholder such as `placeholder:Email`.
- Replay and verify keep going when a step the original run already marked `skipped` has a locator that still misses. A soft skip (for example a placeholder fill that never matched) no longer becomes `locator_mismatch` and hides a later bug, such as a form POST that returned HTTP 500. A step that originally passed or failed still stops the flow. Fingerprints are unchanged.
- A planner model response that is invalid JSON, fails schema validation, or includes a flow with empty `steps` no longer wipes the plan. Usable model flows are kept. The public-form submit flow and scraped fault-control flows are still added, up to `maxFlows`. `plan()` records the model error on `TestPlan.notes` and emits `engine.error`. `executeAndTriage` runs that plan. An empty plan remains only when the crawl has no public form and no fault control. `RunResult` fields are unchanged. `groundedTestPlan(siteMap, maxFlows)` is the same crawl-only floor, for a host that catches a planner failure itself.
- The per-flow timeout no longer leaves its timer running after the flow finishes, and it closes the browser context when the budget is exceeded.

## [0.5.1] — 2026-10-26

### Fixed

- A model site summary that does not match the schema no longer aborts exploration. `authSurfaces` and `publicJourneys` accept a string or an object with `url` / `label` / `name` / `path` and are stored as `string[]`. The same coercion covers the other structured-output calls (per-page summary, planner salvage, bug polish, runner tool choice): string booleans, one object where an array was asked for, enum case and a few tool aliases, over-long polish fields clipped to the limit, and a single planner flow or step object. When the site summary still cannot be read, the crawl keeps the pages it already visited, fills a basic map from titles and URLs, and continues. `SiteMap.warnings` and the `explore.warning` event carry a short sentence safe to show in a report. The parser error stays in the server log and on `data.detail`. Per-page summary failures use the same warning instead of writing the schema error into the page summary.

## [0.5.0] — 2026-10

### Changed

- **Breaking:** the npm package is `@monkeytestai/monkeytester`. It was `@monkeytestai/monkeytest-core`. Update `npm install` and `import` paths. The CLI binary stays `monkeytest` (`npx monkeytest`). The license stays `AGPL-3.0-only`. `publishConfig.access` stays `public`.
- Repository URLs in this repo now use `https://github.com/monkeytestai/monkeytester` (previously `https://github.com/monkeytestai/monkeytest-core`). The GitHub repository rename follows this release. The homepage stays `https://docs.monkeytest.ai`.
- Docs and other in-repo wording for this package use **monkeytester**. The product name **monkeytest**, the `monkeytest` CLI, and the `.monkeytest/` directory are unchanged.
- The Docker install tree is `/opt/monkeytester` (was `/opt/monkeytest-core`). Example tags are `monkeytester:local` and `monkeytester:ci`. `npm pack` tarballs are named `monkeytestai-monkeytester-<version>.tgz`.
- `monkeytest version`, and the `engine` label on newly saved plans and runs, now report `monkeytester@0.5.0`. On-disk schema stays `1`.

## [0.4.1] — 2026-10

### Fixed

- The crawler compared outbound links with `URL.origin`, so a start URL of `http://shop.example/` that redirects to `https://www.shop.example/` never left the homepage: every rewritten link looked off-origin and the queue stopped. Crawl scope now treats the apex host and `www` as one site, and `http` and `https` as one site. Another subdomain, another host, or another explicit port is still skipped. A redirect that stays on the site is stored as the URL the browser landed on; the caller's `startUrl` is unchanged. The fault-surface link check uses the same site rule, so a homepage "Track order" or "Help" link rewritten onto `https://www` is still eligible when that path was not crawled. The public-form floor is unchanged and still requires the form page in the sitemap. `www` / scheme matching for HTTP 5xx oracles is unchanged.

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

[0.6.0]: https://github.com/monkeytestai/monkeytester/releases/tag/v0.6.0
[0.5.1]: https://github.com/monkeytestai/monkeytester/releases/tag/v0.5.1
[0.5.0]: https://github.com/monkeytestai/monkeytester/releases/tag/v0.5.0
[0.4.1]: https://github.com/monkeytestai/monkeytester/releases/tag/v0.4.1
[0.4.0]: https://github.com/monkeytestai/monkeytester/releases/tag/v0.4.0
[0.3.0]: https://github.com/monkeytestai/monkeytester/releases/tag/v0.3.0
[0.2.0]: https://github.com/monkeytestai/monkeytester/releases/tag/v0.2.0
