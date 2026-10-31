# Quick start

[`@monkeytestai/monkeytester`](https://www.npmjs.com/package/@monkeytestai/monkeytester) **0.6.1** is on npm.

```bash
npm install @monkeytestai/monkeytester
npx playwright install chromium
export GEMINI_API_KEY="paste-your-key"
npx monkeytest run https://example.com --max 2 --flows 1
```

pnpm, yarn, and bun install the same package (`pnpm add @monkeytestai/monkeytester`, `yarn add @monkeytestai/monkeytester`, `bun add @monkeytestai/monkeytester`). The sections below are the contributor clone: a local build and a no-key smoke script. A fresh machine spends most of the few minutes on `npm install` and the Chromium download. The smoke run itself is about two seconds.

## Prerequisites

- **Node.js 20 or newer.** `package.json` sets `"engines": { "node": ">=20" }`. Check with `node -v`.
- **git**
- A network connection, for the install, the Playwright browser download, and the smoke crawl of `https://example.com`.

## 1. Clone, install, and build

```bash
git clone https://github.com/monkeytestai/monkeytester.git
cd monkeytester
npm install
npm run build
```

`npm run build` deletes a stale `.tsbuildinfo` if one is present, then compiles `src/` to `dist/`. You want `dist/cli.js` and `dist/index.js` on disk.

On older commits, a committed `.tsbuildinfo` made `tsc` exit 0 while writing only `.d.ts` files. If `dist/cli.js` is missing, run `npm run clean && npm run build`. Details are in [Troubleshooting](/guide/troubleshooting#dist-has-no-js-files-after-npm-run-build).

## 2. Install Chromium

```bash
npx playwright install chromium
```

Playwright downloads its own Chromium (about 170 MB for current builds, plus a headless shell). It does not use a Chrome you already have installed. In CI, use `npx playwright install --with-deps chromium` so the operating-system libraries come along.

## 3. Try it without an API key

```bash
node scripts/smoke.mjs
```

`scripts/smoke.mjs` stubs the LLM with canned JSON, opens Chromium, crawls `https://example.com`, and asks the stub planner for one flow. It does not read an API key and it does not write `.monkeytest/`.

A successful run looks like this (the time will vary):

```text
  · visited https://example.com/ — Static placeholder page used as the canonical example domain.

[explore] done in 1.1 s
  pages: 1 failures: 0
  siteType: placeholder

[plan] flows: 1
  - [happy_path] Visit the example.com homepage (2 steps)

OK — engine pipeline is wired correctly.
```

The last line is the success signal. Then confirm the CLI is the binary you just built:

```bash
node dist/cli.js --help
```

The help text lists `init`, `explore`, `run`, `rerun`, `diff`, and `report`. Inside this clone the command is `node dist/cli.js`. After `npm install @monkeytestai/monkeytester`, the same binary is `npx monkeytest` (or `monkeytest` if you installed it globally).

## 4. First real run (free Gemini key)

Create a key at <https://aistudio.google.com/apikey>. Export it in the same shell you use to run the CLI. Gemini is the first provider auto-detect looks for.

```bash
export GEMINI_API_KEY="paste-your-key"
node dist/cli.js run https://example.com --max 2 --flows 1
```

`--max` is the page cap (default 8). `--flows` is the planner cap (default 6). The small numbers keep a first run short. `example.com` is a safe public page; point the same command at a staging URL when you want bugs from your own app.

### What you should see

The CLI prints each visited URL, then each flow and step. When it finishes it prints three paths under `./.monkeytest/`:

| Path | What it is |
| --- | --- |
| `.monkeytest/plan.json` | The plan. `rerun` executes this file again. |
| `.monkeytest/runs/<timestamp>.json` | The run: flows, step results, bugs, stats. |
| `.monkeytest/shots/page-*.png` | One viewport PNG per crawled page. |
| `.monkeytest/shots/flow-*-step-*-*.png` | One PNG per step. |
| `.monkeytest/shots/flow-*.webm` | One video per flow. |

Screenshots and video go in **`shots/`**. There is no `.monkeytest/screenshots/` directory.

`run` does not write `sitemap.json`. This does:

```bash
node dist/cli.js explore https://example.com --max 2 --flows 1
```

`explore` crawls and plans, writes `sitemap.json` and `plan.json`, and does not execute the flows.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Finished, and no blocking bug (severity other than `minor`). |
| 1 | `run` or `rerun` found a blocking bug. `diff` found a new bug or a severity regression. |
| 2 | Bad arguments, or no provider configured. The browser does not open. |
| 3 | The engine threw. An invalid API key lands here, after the crawl. See [Troubleshooting](/guide/troubleshooting). |

## Fully local with Ollama

The LLM client for `openai_compatible` is the OpenAI SDK pointed at a `baseURL`. Ollama's OpenAI-compatible server is `http://127.0.0.1:11434/v1`. Install [Ollama](https://ollama.com), pull a model, then:

```bash
ollama pull llama3.1:8b
export OPENAI_COMPATIBLE_BASE_URL="http://127.0.0.1:11434/v1"
export OPENAI_COMPATIBLE_API_KEY="ollama"
node dist/cli.js run https://example.com \
  --provider openai_compatible \
  --base-url "http://127.0.0.1:11434/v1" \
  --model llama3.1:8b \
  --max 2 --flows 1
```

These match `src/llm/index.ts` and `src/llm/presets.ts`:

- **`--provider openai_compatible`** forces the local server. Auto-detect only chooses it when `OPENAI_COMPATIBLE_BASE_URL` is set and none of these are set: `GEMINI_API_KEY` or `GOOGLE_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `MISTRAL_API_KEY`, `GROQ_API_KEY`. A leftover Gemini key would silently win.
- **`--model`** has to be the tag you pulled. The built-in default for this provider is `gpt-4o-mini`, which is not an Ollama tag.
- **`--base-url`** is the endpoint. If you omit the flag, `createLLM` falls back to `OPENAI_COMPATIBLE_BASE_URL`. The CLI help text still describes the flag as required; set both and the command is unambiguous.
- **API key.** Ollama ignores it. The client uses `--api-key`, then `OPENAI_COMPATIBLE_API_KEY`, then the literal `sk-no-key-required`. Any non-empty string is enough.
- **JSON mode** is turned off when the base URL matches `ollama`, `localhost`, or `127.0.0.1`. Local servers often reject `response_format`. A remote host whose URL contains none of those strings keeps JSON mode on.

The same shape from TypeScript, run inside the clone with `npx tsx your-script.ts` (tsx is a devDependency):

```ts
import { Monkey } from './src/index.ts';

const local = {
  provider: 'openai_compatible' as const,
  baseURL: 'http://127.0.0.1:11434/v1',
  apiKey: 'ollama',
  model: 'llama3.1:8b',
};

const monkey = new Monkey({
  llm: { explorer: local, planner: local, runner: local },
});

const { run } = await monkey.executeAndTriage('https://example.com', {
  explore: { maxPages: 2, screenshotsDir: '.monkeytest/shots' },
  plan: { maxFlows: 1 },
  run: { screenshotsDir: '.monkeytest/shots', headless: true },
});

console.log(run.stats);
```

More providers and the per-phase model tables are on [LLM providers](/guide/llm-providers).

## 5. Rerun the same plan, then diff

After step 4 has written `plan.json` and a file in `runs/`:

```bash
node dist/cli.js rerun
node dist/cli.js diff prev latest
```

`rerun` loads `.monkeytest/plan.json` and executes that plan. It skips the crawl and the planner, and it writes a new file under `runs/`. It still calls the LLM once per step, so the same provider configuration has to be in the environment. Use another `run` only when you want a new crawl and a new plan.

`diff prev latest` compares bug fingerprints. `latest` is the newest file in `.monkeytest/runs/`, `prev` is the one before it. `diff` does not call an LLM and does not open a browser. It exits 1 when something new appeared or a bug got more severe.

`node dist/cli.js report` prints the latest run: flows, steps, and the `shots/` path stored on each step.

## Library sketch

This is the call most of the other pages show. It imports the published package. Inside this clone, import `./src/index.ts` from a `tsx` script, or `./dist/index.js` from plain Node.

```ts
import { Monkey, autoLLMConfig } from '@monkeytestai/monkeytester';

const monkey = new Monkey({ llm: autoLLMConfig({ quality: 'balanced' }) });

const { run } = await monkey.executeAndTriage('https://example.com', {
  explore: { maxPages: 8, screenshotsDir: '.monkeytest/shots' },
  plan:    { maxFlows: 4 },
  run:     { screenshotsDir: '.monkeytest/shots' },
});

console.log(`${run.bugs.length} bug(s) across ${run.stats.flowsTotal} flows`);
```

`autoLLMConfig({ quality: 'balanced' })` uses the cheap model for the explorer and the runner, and the smart model for the single planning call. The preset tables are on [Cost & depth](/guide/cost-and-depth).

`monkeytest init` creates `.monkeytest/` with a `config.json`. The CLI does not read that file. Flags and environment variables are the configuration that takes effect. See the [CLI reference](/reference/cli#monkeytest-init).

Next: [Why monkeytest](/guide/why-monkeytest) · [The bug-finding loop](/guide/the-bug-finding-loop)
