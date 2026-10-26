# Recipes

Battle-tested patterns for getting real value out of monkeytester. Copy, paste, adjust.

## Test a deploy preview, fail the build on bugs

```ts
import { Monkey, autoLLMConfig } from '@monkeytestai/monkeytester';

const monkey = new Monkey({ llm: autoLLMConfig({ quality: 'balanced' }) });

const { run } = await monkey.executeAndTriage(process.env.PREVIEW_URL!, {
  explore: { maxPages: 6, screenshotsDir: '.monkeytest/shots' },
  plan:    { maxFlows: 4 },
  run:     { screenshotsDir: '.monkeytest/shots', headless: true },
});

const blocking = run.bugs.filter(b => b.severity !== 'minor');
if (blocking.length){
  console.error(`Found ${blocking.length} blocking bugs:`);
  for (const b of blocking) console.error(`- [${b.severity}] ${b.title}`);
  process.exit(1);
}
```

## Persist a run to disk and diff it later

```ts
import { writeFileSync } from 'node:fs';

const result = await monkey.executeAndTriage(url, { explore: ..., plan: ..., run: ... });

writeFileSync(
  `runs/${new Date().toISOString()}.json`,
  JSON.stringify({ siteMap: result.siteMap, plan: result.plan, run: result.run }, null, 2),
);
```

Bug `fingerprint`s are stable across runs, so you can diff `bugs[].fingerprint` between two runs to know what's **new**, **fixed**, or **regressed**.

## Live progress in your CLI

```ts
import { Monkey, EventBus, autoLLMConfig } from '@monkeytestai/monkeytester';

const events = new EventBus();
events.on(e => {
  const tag = `[${e.phase}/${e.type}]`.padEnd(28);
  console.log(`${new Date(e.ts).toLocaleTimeString()} ${tag} ${e.message}`);
});

await new Monkey({ llm: autoLLMConfig() }).executeAndTriage(url, {
  events,
  explore: { maxPages: 8, screenshotsDir: '.monkeytest/shots' },
  plan:    { maxFlows: 4 },
  run:     { screenshotsDir: '.monkeytest/shots' },
});
```

## Stream live progress over SSE

```ts
import express from 'express';
import { EventBus } from '@monkeytestai/monkeytester';

const app = express();
const buses = new Map<string, EventBus>();

app.get('/runs/:id/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const bus = buses.get(req.params.id);
  if (!bus) return res.end();
  const off = bus.on(evt => res.write(`data: ${JSON.stringify(evt)}\n\n`));
  req.on('close', off);
});
```

## Headed mode (watch the monkey work)

Helpful when debugging selectors or auth flows.

```ts
await monkey.executeAndTriage(url, {
  explore: { maxPages: 4, headless: false, screenshotsDir },
  plan:    { maxFlows: 2 },
  run:     { screenshotsDir, headless: false },
});
```

## Cheap local dev with Ollama

```ts
import { Monkey } from '@monkeytestai/monkeytester';

const monkey = new Monkey({
  llm: {
    explorer: { provider: 'openai_compatible', baseURL: 'http://localhost:11434/v1', apiKey: 'ollama', model: 'llama3.1:8b' },
    planner:  { provider: 'openai_compatible', baseURL: 'http://localhost:11434/v1', apiKey: 'ollama', model: 'llama3.1:70b' },
    runner:   { provider: 'openai_compatible', baseURL: 'http://localhost:11434/v1', apiKey: 'ollama', model: 'llama3.1:8b' },
  },
});
```

## Polished bug reports for production runs

Add a cheap triager LLM and the engine rewrites every bug's copy after the deterministic pass. Per-bug try/catch — failures keep the rule-based copy.

```ts
new Monkey({
  llm: {
    explorer: { provider: 'gemini',    model: 'gemini-flash-lite-latest' },
    planner:  { provider: 'anthropic', model: 'claude-sonnet-4-5' },
    runner:   { provider: 'groq',      model: 'llama-3.3-70b-versatile' },
    triager:  { provider: 'anthropic', model: 'claude-haiku-4-5' },
  },
});
```

See [Triager polish](/guide/triager) for what changes and how to control cost.

## Use Anthropic for the planner only

The single best price/quality lever:

```ts
new Monkey({
  llm: {
    explorer: { provider: 'gemini',    model: 'gemini-flash-lite-latest' },
    planner:  { provider: 'anthropic', model: 'claude-sonnet-4-5' },
    runner:   { provider: 'gemini',    model: 'gemini-flash-lite-latest' },
  },
});
```

## Test only specific user journeys

The library doesn't (yet) accept a hand-written plan, but you can pass a deeper start URL so the planner focuses on a specific area:

```ts
await monkey.executeAndTriage('https://app.example.com/checkout', {
  explore: { maxPages: 4, screenshotsDir },
  plan:    { maxFlows: 3, includeAuthFlows: false },
  run:     { screenshotsDir, headless: true },
});
```

## Embed in your own product

The package is ESM, fully typed, and has zero opinionated dependencies on a host framework. Wrap it in a worker, an API route, a Tauri app, a VS Code extension — wherever.

```ts
// worker/runMonkey.ts
import { Monkey, autoLLMConfig, EventBus } from '@monkeytestai/monkeytester';

export async function runMonkeyTest({ url, screenshotsDir, onEvent }) {
  const events = new EventBus();
  events.on(onEvent);

  const monkey = new Monkey({ llm: autoLLMConfig({ quality: 'balanced' }) });
  return monkey.executeAndTriage(url, {
    events,
    explore: { maxPages: 8, screenshotsDir },
    plan:    { maxFlows: 4 },
    run:     { screenshotsDir, headless: true },
  });
}
```

Next: [Use in CI →](/guide/ci)
