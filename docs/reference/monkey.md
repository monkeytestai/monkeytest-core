# `Monkey` class

## Constructor

```ts
import { Monkey } from '@mtai/monkeytest-core';

const monkey = new Monkey({
  llm: {
    explorer: { provider: 'openai', model: 'gpt-4o-mini', apiKey: process.env.OPENAI_API_KEY! },
    planner:  { provider: 'openai', model: 'gpt-4o-mini', apiKey: process.env.OPENAI_API_KEY! },
  },
});
```

## `executeAndTriage(startUrl, options)`

Runs the full pipeline. Resolves even when exploration or planning partially fails — check `plan.flows.length` and `run.stats`.

**Options** — see [Configuration](/guide/configuration).

## `exploreAndPlan(startUrl, options)`

Runs **only** exploration + planning (no Playwright execution phase).

## `run(startUrl, options)` (async iterator)

Legacy streaming API for explore + plan events. Prefer `executeAndTriage` + `EventBus` for new code.
