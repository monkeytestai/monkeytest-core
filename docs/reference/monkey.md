# `Monkey` class

The high-level orchestrator. Build it once with an `MonkeyLLMConfig`, then call `executeAndTriage` (or one of the lower-level methods) for each run.

## Constructor

```ts
import { Monkey } from '@mtai/monkeytest-core';

const monkey = new Monkey({
  llm: {
    explorer: { provider: 'gemini',    model: 'gemini-flash-lite-latest' },
    planner:  { provider: 'anthropic', model: 'claude-sonnet-4-5' },
    runner:   { provider: 'groq',      model: 'llama-3.3-70b-versatile' },
    // triager is optional and currently rule-based
  },
});
```

If `runner` is omitted, the planner LLM is reused for runner calls. See [LLM providers](/guide/llm-providers) and [Configuration](/guide/configuration).

### Hard-fault defaults

`strictOracles` and `failOn5xx` both default to **on**. A page error, a document HTTP 404, a disabled control the step uses, and a same-origin HTTP ≥500 become blocking bugs. Pass either flag as `false` to restore the previous, quieter bug counts. One call can override the constructor with `run.strictOracles` or `run.failOn5xx`.

`runPlan`, `replayTraces`, and `triage(run)` do not turn those switches on by themselves. `executeAndTriage` does, because it goes through `Monkey`.

### Convenience constructor

```ts
import { Monkey, autoLLMConfig } from '@mtai/monkeytest-core';

const monkey = new Monkey({ llm: autoLLMConfig({ quality: 'balanced' }) });
```

## `executeAndTriage(startUrl, options)`

Runs the full pipeline (`explore → plan → run → triage`).

```ts
const { siteMap, plan, run } = await monkey.executeAndTriage(url, {
  events,                                                  // optional EventBus
  explore: { maxPages: 8, screenshotsDir: '.monkeytest/shots' },
  plan:    { maxFlows: 4 },
  run:     { screenshotsDir: '.monkeytest/shots', headless: true },
});
```

**Always resolves**, even when explore or plan partially fail. Always check:

```ts
if (plan.flows.length === 0) console.warn(plan.notes);
console.log(run.stats);
```

Option references:

- `events` → [`EventBus`](/reference/events)
- `explore` → `ExploreOptions` ([Configuration](/guide/configuration#exploreoptions))
- `plan`    → `PlannerOptions` ([Configuration](/guide/configuration#planneroptions))
- `run`     → `RunnerOptions` (required) ([Configuration](/guide/configuration#runneroptions))

## `exploreAndPlan(startUrl, options)`

Same as above but stops after planning — useful when you only want a `SiteMap` + `TestPlan` (no Playwright execution).

```ts
const { siteMap, plan } = await monkey.exploreAndPlan(url, {
  events,
  explore: { maxPages: 6, screenshotsDir: '.monkeytest/shots' },
  plan:    { maxFlows: 4 },
});
```

## `run(startUrl, options)` (async iterator)

Legacy streaming API yielding typed `MonkeyEvent`s. Prefer `executeAndTriage` + an `EventBus` for new code — it covers all phases and is what the SaaS ships against.

```ts
for await (const evt of monkey.run(url, { explore: { maxPages: 4 } })) {
  if (evt.type === 'plan.complete') console.log(evt.plan);
}
```

## Lifecycle guarantees

| Failure | What you still get |
| ------- | ------------------ |
| Some pages fail to load | The `SiteMap` with whatever pages did succeed |
| The planner LLM throws or returns invalid JSON | The `SiteMap`, an `engine.error` event, and a `plan` of grounded form and fault flows when the crawl has them. `notes` include the model error. An empty plan remains only when there is nothing on the sitemap to ground. |
| A flow blows up mid-execution | All steps that ran, their screenshots, and a `failed` `FlowResult` |

The engine never throws out of `executeAndTriage` for these cases — it always resolves with structured data. Real exceptions only escape for unrecoverable problems (no `screenshotsDir` writable, missing API key, etc.).
