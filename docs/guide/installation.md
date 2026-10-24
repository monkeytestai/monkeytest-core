# Installation

[`@monkeytestai/monkeytest-core`](https://www.npmjs.com/package/@monkeytestai/monkeytest-core) **0.4.1** is published on npm. `npm install @monkeytestai/monkeytest-core` is the install. A clone is the path for contributors.

## Requirements

- **Node.js 20+** (`node -v`). The engine is native ESM and uses `node:` builtins.
- **Playwright Chromium**, downloaded once with `npx playwright install chromium` (about 170 MB for current builds, plus a headless shell).
- An **LLM API key** only when you want a real crawl-plan-run. The smoke script in the [quick start](/guide/quick-start) uses a stub LLM and needs no key.

## npm

::: code-group

```bash [npm]
npm install @monkeytestai/monkeytest-core
npx playwright install chromium
```

```bash [pnpm]
pnpm add @monkeytestai/monkeytest-core
pnpm exec playwright install chromium
```

```bash [yarn]
yarn add @monkeytestai/monkeytest-core
yarn playwright install chromium
```

```bash [bun]
bun add @monkeytestai/monkeytest-core
bunx playwright install chromium
```

:::

The package is ESM, ships TypeScript declarations, and exposes a `monkeytest` binary (`npx monkeytest`, or `monkeytest` after a global install). Releases are published from [`.github/workflows/release.yml`](https://github.com/monkeytestai/monkeytest-core/blob/main/.github/workflows/release.yml) on a `v*` tag, with [npm provenance](https://docs.npmjs.com/generating-provenance-statements).

## From a clone (contributors)

The clone is how you change the engine. It also runs the no-key smoke script, which is not in the published package.

```bash
git clone https://github.com/monkeytestai/monkeytest-core.git
cd monkeytest-core
npm install
npm run build
npx playwright install chromium
node scripts/smoke.mjs
```

`npm run build` writes `dist/`, including `dist/cli.js`. Run the CLI with `node dist/cli.js`. Step-by-step output, the Gemini command, and Ollama are on the [quick start](/guide/quick-start).

`npm run build` removes `.tsbuildinfo` before `tsc`, and TypeScript incremental mode is off. A fresh build emits `.js` and `.d.ts`. If you are on an older commit and `dist/` contains only declaration files, run `npm run clean && npm run build`.

## Set up a provider when you want a real run

Auto-detect walks this list and uses the first one that is set:

| Variable | Provider | Key |
| --- | --- | --- |
| `GEMINI_API_KEY` or `GOOGLE_API_KEY` | Google Gemini | <https://aistudio.google.com/apikey> |
| `OPENAI_API_KEY` | OpenAI | <https://platform.openai.com/api-keys> |
| `ANTHROPIC_API_KEY` | Anthropic Claude | <https://console.anthropic.com/settings/keys> |
| `MISTRAL_API_KEY` | Mistral | <https://console.mistral.ai/api-keys/> |
| `GROQ_API_KEY` | Groq | <https://console.groq.com/keys> |
| `OPENAI_COMPATIBLE_BASE_URL` | Ollama, vLLM, LM Studio, OpenRouter, … | The base URL. `OPENAI_COMPATIBLE_API_KEY` is optional for local servers |

A missing variable fails immediately (exit 2), before Chromium launches. A variable that is set to a rejected key fails later, after the crawl, with the provider's raw error (exit 3). Both cases are in [Troubleshooting](/guide/troubleshooting).

```bash
export GEMINI_API_KEY="paste-your-key"
npx monkeytest run https://example.com --max 2 --flows 1
```

From a clone, the same command is `node dist/cli.js run https://example.com --max 2 --flows 1`.

Outputs land in `.monkeytest/plan.json`, `.monkeytest/runs/`, and `.monkeytest/shots/`. The copy-paste Ollama block is on the [quick start](/guide/quick-start#fully-local-with-ollama).

Next: [Quick start →](/guide/quick-start)
