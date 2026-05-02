# Changelog

All notable changes to **MonkeyTest Core** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.3.0]: https://github.com/monkeytest-ai/monkeytest-core/releases/tag/v0.3.0
[0.2.0]: https://github.com/monkeytest-ai/monkeytest-core/releases/tag/v0.2.0
