# Reference: Overview

`@mtai/monkeytest-core` is a single ESM package with a small, stable surface. The package name is not on the npm registry yet (404 as of 23 Oct 2026). Build from source with the [quick start](/guide/quick-start), then import `./dist/index.js` from Node or `./src/index.ts` from `tsx`. The import below is the public surface once the package is installed.

All public exports come from the package root:

```ts
import {
  Monkey,
  EventBus,
  autoLLMConfig,
  detectProviderFromEnv,
  CHEAP_FAST_MODEL,
  SMART_MODEL,
  createLLM,
  explore,
  plan,
  runPlan,
  triage,
  triagePolished,
  noopBus,
} from '@mtai/monkeytest-core';
```

| Export | Role |
| ------ | ---- |
| [`Monkey`](/reference/monkey) | High-level orchestrator: explore → plan → run → triage. |
| [`EventBus`, `noopBus`](/reference/events) | Live event channel between the engine and your host. |
| `autoLLMConfig` | Sensible `MonkeyLLMConfig` from env + a quality preset. |
| `detectProviderFromEnv` | Returns the first usable provider for the current env. |
| `CHEAP_FAST_MODEL`, `SMART_MODEL` | Lookup tables of recommended models per provider. |
| `createLLM` | Low-level: build one `LLM` from one `LLMConfig`. |
| `explore`, `plan`, `runPlan` | Phase functions, if you want to drive the pipeline yourself. |
| `triage` | Deterministic rule-based triager. Always free. |
| `triagePolished` | Same triager + optional LLM polish pass for prettier copy. See [Triager polish](/guide/triager). |

## Result of `executeAndTriage`

```ts
const { siteMap, plan, run } = await monkey.executeAndTriage(url, opts);
```

| Field | Type (sketch) | Notes |
| ----- | ------------- | ----- |
| `siteMap` | `{ startUrl, siteType, summary, pages[], pendingUrls[], failedUrls[] }` | Always returned, even if no pages succeeded. |
| `plan` | `{ startUrl, siteType, flows: TestFlow[], notes? }` | `flows` may be empty if the planner failed; check `notes`. |
| `run` | `{ flows: FlowResult[], bugs: BugReport[], stats }` | `bugs` are deduplicated and fingerprinted. |

## Type tree (high level)

```
SiteMap
 ├─ pages: SiteMapPage[]              { url, title, summary, interactive[], outboundLinks[], authGated, screenshotPath? }
 └─ failedUrls: { url, reason }[]

TestPlan
 └─ flows: TestFlow[]                 { id, name, kind, startUrl, steps: TestStep[], severityIfFails, expectation }

RunResult
 ├─ flows: FlowResult[]               { flowId, status, durationMs, videoPath?, steps: StepResult[] }
 │    └─ steps: StepResult[]          { index, action, status, observation, screenshotPath?, consoleErrors[], networkFailures[] }
 ├─ bugs: BugReport[]                 { id, fingerprint, title, severity, evidence: { screenshots[], consoleErrors[], networkFailures[] } }
 └─ stats                             { flowsTotal, flowsPassed, flowsFailed, stepsTotal, stepsPassed, stepsFailed, bugsCritical, bugsMajor, bugsMinor }
```

The full `.d.ts` ships next to `dist/index.js` and is the source of truth.

## LLM configuration types

```ts
type LLMProvider =
  | 'openai' | 'gemini' | 'anthropic' | 'mistral' | 'groq' | 'openai_compatible';

interface LLMConfig {
  provider: LLMProvider;
  model?: string;
  apiKey?: string;
  baseURL?: string;       // for `openai_compatible`
  temperature?: number;   // default 0.2
}

interface MonkeyLLMConfig {
  explorer: LLMConfig;
  planner:  LLMConfig;
  runner?:  LLMConfig;    // optional; falls back to planner
  triager?: LLMConfig;    // optional; enables LLM polish pass on bug copy
}

// Token + cache stats from the last LLM call.
// Read via `llm.lastUsage`, or via `evt.data.usage` on plan.complete /
// triage.complete events.
interface LLMUsage {
  inputTokens?: number;
  cachedInputTokens?: number;   // OpenAI auto-cache; Anthropic ephemeral
  outputTokens?: number;
  cacheWrite?: boolean;          // Anthropic only
}
```

See the [LLM providers](/guide/llm-providers) and [Prompt caching](/guide/prompt-caching) guides for what to pick where.

Next: [Monkey class →](/reference/monkey)
