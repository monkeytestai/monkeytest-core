# Quick start

Three ways to run MonkeyTest Core: **CLI**, **two-line programmatic**, and **fully configured**.

## 1. CLI

After [installing](/guide/installation):

```bash
export GEMINI_API_KEY=...
npx monkeytest explore https://example.com
```

You'll get:

- `.monkeytest/sitemap.json` — pages visited, summaries, screenshot paths
- `.monkeytest/plan.json` — flows the planner thinks are worth running
- `.monkeytest/screenshots/page-*.png` — one PNG per crawled page

## 2. Two-line programmatic (auto LLM)

`autoLLMConfig()` picks a provider from your env and uses sensible cheap/balanced/smart presets, so you can be running in **two lines**:

```ts
import { Monkey, autoLLMConfig } from '@mtai/monkeytest-core';

const monkey = new Monkey({ llm: autoLLMConfig({ quality: 'balanced' }) });

const { run } = await monkey.executeAndTriage('https://example.com', {
  explore: { maxPages: 8, screenshotsDir: '.monkeytest/shots' },
  plan:    { maxFlows: 4 },
  run:     { screenshotsDir: '.monkeytest/shots' },
});

console.log(`${run.bugs.length} bug(s) across ${run.stats.flowsTotal} flows`);
for (const bug of run.bugs){
  console.log(`- [${bug.severity}] ${bug.title}`);
}
```

`quality` controls the preset:

| `quality`  | Explorer | Planner | Runner | Use when |
| ---------- | -------- | ------- | ------ | -------- |
| `cheap`    | cheap fast model | cheap fast model | cheap fast model | CI smoke tests, daily cron |
| `balanced` (default) | cheap fast model | smart model | cheap fast model | normal use |
| `smart`    | smart model | smart model | smart model | hard-to-reach bugs, low call volume |

See [Cost & depth](/guide/cost-and-depth) for what each preset costs per run.

## 3. Fully configured

Mix providers per phase — for example, a smart Anthropic planner with a cheap Groq runner for hot-path step decisions:

```ts
import { Monkey, EventBus } from '@mtai/monkeytest-core';

const events = new EventBus();
events.on(e => console.log(`[${e.phase}] ${e.message}`));

const monkey = new Monkey({
  llm: {
    explorer: { provider: 'gemini',    model: 'gemini-flash-lite-latest' },
    planner:  { provider: 'anthropic', model: 'claude-sonnet-4-5' },
    runner:   { provider: 'groq',      model: 'llama-3.3-70b-versatile' },
  },
});

const { siteMap, plan, run } = await monkey.executeAndTriage('https://example.com', {
  events,
  explore: { maxPages: 12, screenshotsDir: '.monkeytest/shots' },
  plan:    { maxFlows: 6 },
  run:     { screenshotsDir: '.monkeytest/shots', headless: true, stepTimeoutMs: 20000 },
});
```

Every phase can use a different provider. See [LLM providers](/guide/llm-providers) for what to pick where.

## What's in `run`

```ts
type RunResult = {
  startUrl: string;
  startedAt: string; finishedAt: string;
  flows: FlowResult[];   // every step's outcome + screenshotPath + videoPath
  bugs: BugReport[];     // deduplicated, fingerprinted, with evidence
  stats: { flowsTotal, flowsPassed, flowsFailed, bugsCritical, bugsMajor, bugsMinor, ... };
};
```

See [Reference: Overview](/reference/overview) for the full type tree.

Next: [How it works →](/guide/architecture)
