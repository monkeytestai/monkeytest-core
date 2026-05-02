# Configuration

## `Monkey` constructor

```ts
new Monkey({
  llm: {
    explorer: { provider: 'openai' | 'gemini', model?: string, apiKey?: string },
    planner:  { provider: 'openai' | 'gemini', model?: string, apiKey?: string },
  },
});
```

The runner currently reuses the **planner** model for per-step tool resolution.

## `executeAndTriage` options

| Option | Description |
| ------ | ----------- |
| `events` | Optional `EventBus` for [live events](/guide/live-events). |
| `explore.maxPages` | Max pages to crawl (default `8`). |
| `explore.screenshotsDir` | Directory for per-page PNGs. |
| `explore.headless` | Default `true`. |
| `plan.maxFlows` | Max planned flows (default `6`). |
| `plan.includeAuthFlows` | Include `auth_required` flows (default `true`). |
| `run.screenshotsDir` | **Required** — per-step screenshots and flow video. |
| `run.headless` | Default `true`. |
| `run.stepTimeoutMs` | Per-step timeout (default `15000`). |
| `run.flowTimeoutMs` | Per-flow wall clock (default `180000`). |
| `run.onEvent` | Legacy callback for runner events (same stream as `events` for runner phase). |

## Model selection tips

- **OpenAI** — Often more stable under load than free-tier Gemini.
- **Gemini Flash** — Very low cost; may return `503` when capacity is high.

This documentation is for the **open-source engine** only. Hosted quotas and defaults on [MonkeyTest Cloud](https://monkeytest.ai) may differ.
