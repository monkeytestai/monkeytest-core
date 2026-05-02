# Configuration

The engine has three configuration surfaces:

1. **`Monkey` constructor** — which LLMs to use for which phase.
2. **`executeAndTriage` options** — explorer / planner / runner tuning.
3. **Environment variables** — provider API keys (or pass `apiKey` inline).

## `Monkey` constructor

```ts
new Monkey({
  llm: {
    explorer: { provider: 'gemini',    model: 'gemini-flash-lite-latest' },
    planner:  { provider: 'openai',    model: 'gpt-4o' },
    runner:   { provider: 'groq',      model: 'llama-3.3-70b-versatile' },
    triager:  { provider: 'anthropic', model: 'claude-haiku-4-5' }, // optional polish pass
  },
});
```

Tier semantics:

| Tier | Calls per run | Recommendation |
| ---- | ------------- | -------------- |
| `explorer` | 1 per crawled page (`maxPages`, default 8) | **Cheap, fast.** Same model you'd use for a chatbot. |
| `planner` | **1 per run.** | **Smart.** This is where you actually pay for intelligence. |
| `runner` | 1 per step (`maxFlows × steps`, typically 10–40) | **Cheap, fast.** Hot path. |
| `triager` | 1 per bug (capped at 25, concurrency 4). Opt-in. | **Cheap, fast.** Rewrites bug copy from evidence. See [Triager polish](/guide/triager). |

If you omit `runner`, the engine reuses the `planner` model for runner calls (back-compat). If you omit `triager`, the deterministic rule-based triager runs alone (zero extra LLM cost).

The same shape works for **mixed providers** — there's no constraint that all phases use the same vendor.

## `LLMConfig`

```ts
interface LLMConfig {
  provider: 'openai' | 'gemini' | 'anthropic' | 'mistral' | 'groq' | 'openai_compatible';
  model?: string;       // provider-specific; cheap default per provider if omitted
  apiKey?: string;      // falls back to provider env var if omitted
  baseURL?: string;     // for `openai_compatible` (Ollama, vLLM, OpenRouter, …)
  temperature?: number; // default 0.2 (JSON tasks)
}
```

See [LLM providers](/guide/llm-providers) for env var names, recommended models, and per-provider quirks.

## `executeAndTriage` options

```ts
const { siteMap, plan, run } = await monkey.executeAndTriage(url, {
  events,
  explore: { /* ExploreOptions */ },
  plan:    { /* PlannerOptions */ },
  run:     { /* RunnerOptions  — required */ },
});
```

### `ExploreOptions`

| Option | Default | Meaning |
| ------ | ------- | ------- |
| `maxPages` | `8` | Hard cap on pages crawled. Each page = one LLM call. |
| `pageTimeoutMs` | `20000` | Per-page navigation timeout. |
| `headless` | `true` | Set `false` to watch it crawl. |
| `screenshotsDir` | (none) | If set, take a viewport-sized PNG of every page; path stored on `SiteMapPage.screenshotPath`. |
| `onPage` | (none) | Per-page callback (used internally by `Monkey.run`). |
| `events` | (none) | `EventBus` for live events. |

### `PlannerOptions`

| Option | Default | Meaning |
| ------ | ------- | ------- |
| `maxFlows` | `6` | Soft cap on flows the planner can return. |
| `includeAuthFlows` | `true` | Include flows the LLM tagged `auth_required` (the runner surfaces them as "needs creds"). |
| `events` | (none) | `EventBus`. |

### `RunnerOptions`

| Option | Default | Meaning |
| ------ | ------- | ------- |
| `screenshotsDir` | **required** | Where step PNGs and per-flow WebMs are written. |
| `stepTimeoutMs` | `15000` | Per-step navigation/action timeout. |
| `flowTimeoutMs` | `180000` | Hard cap on a flow's wall clock. |
| `headless` | `true` | Set `false` to watch flows run. |
| `onEvent` | (none) | Legacy per-step callback. Same data as the runner-phase events on `events`. |
| `events` | (none) | `EventBus`. |

## Depth presets via `autoLLMConfig`

If you don't want to think tiers at all:

```ts
import { autoLLMConfig } from '@mtai/monkeytest-core';

new Monkey({ llm: autoLLMConfig({ quality: 'balanced' }) });
```

| `quality` | Explorer | Planner | Runner |
| --------- | -------- | ------- | ------ |
| `cheap` | cheap | cheap | cheap |
| `balanced` (default) | cheap | smart | cheap |
| `smart` | smart | smart | smart |

You can override individual tiers:

```ts
autoLLMConfig({
  quality: 'balanced',
  overrides: { runner: { provider: 'groq', model: 'llama-3.3-70b-versatile' } },
});
```

## Environment variables (full list)

| Variable | Purpose |
| -------- | ------- |
| `OPENAI_API_KEY` | OpenAI provider |
| `OPENAI_MODEL` | Optional default OpenAI model id |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | Gemini provider |
| `ANTHROPIC_API_KEY` | Anthropic provider |
| `MISTRAL_API_KEY` | Mistral provider |
| `GROQ_API_KEY` | Groq provider |
| `OPENAI_COMPATIBLE_API_KEY` | API key for any OpenAI-compatible server |
| `OPENAI_COMPATIBLE_BASE_URL` | URL for any OpenAI-compatible server (Ollama / vLLM / OpenRouter / …) |
| `PLAYWRIGHT_BROWSERS_PATH` | Where Chromium binaries live; standard Playwright env. |

Next: [LLM providers →](/guide/llm-providers)
