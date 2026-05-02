# Quick start

## Programmatic API

```ts
import { Monkey, EventBus } from '@mtai/monkeytest-core';

const events = new EventBus();
events.on((e) => console.log(`[${e.phase}] ${e.message}`));

const monkey = new Monkey({
  llm: {
    explorer: { provider: 'openai', model: 'gpt-4o-mini', apiKey: process.env.OPENAI_API_KEY },
    planner:  { provider: 'openai', model: 'gpt-4o-mini', apiKey: process.env.OPENAI_API_KEY },
  },
});

const { siteMap, plan, run } = await monkey.executeAndTriage('https://example.com', {
  events,
  explore: { maxPages: 8, screenshotsDir: '.monkeytest/screenshots' },
  plan:    { maxFlows: 4 },
  run:     { screenshotsDir: '.monkeytest/screenshots', headless: true },
});

console.log(run.bugs);
```

## CLI

The package exposes a `monkeytest` binary after build:

```bash
npm run build
node dist/cli.js explore https://example.com
```

## Outputs

- **Site map** — pages visited, summaries, screenshot paths  
- **Test plan** — flows and steps for the runner  
- **Run result** — step outcomes, screenshots, optional video paths, triaged bugs  

See [Reference overview](/reference/overview) for types.

Next: [Configuration](/guide/configuration) →
