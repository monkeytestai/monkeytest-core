# Installation

## Requirements

- **Node.js 20+** (the engine uses native ESM, `node:` builtins, and `AbortController`)
- **Playwright Chromium** (one-time download, ~150 MB)
- An **LLM API key** for at least one [supported provider](/guide/llm-providers)

## Install

::: code-group

```bash [npm]
npm install @mtai/monkeytest-core
npx playwright install chromium
```

```bash [pnpm]
pnpm add @mtai/monkeytest-core
pnpm exec playwright install chromium
```

```bash [yarn]
yarn add @mtai/monkeytest-core
yarn playwright install chromium
```

```bash [bun]
bun add @mtai/monkeytest-core
bunx playwright install chromium
```

:::

The package ships as ESM with TypeScript declarations and a single binary (`monkeytest`). It's published with [npm provenance](https://docs.npmjs.com/generating-provenance-statements) so consumers can verify it was built by the project's official CI workflow.

## From source

```bash
git clone https://github.com/monkeytest-ai/monkeytest-core.git
cd monkeytest-core
npm install
npx playwright install chromium
npm run build
```

This produces a `dist/` folder you can `node dist/cli.js …` against, or `npm link` into another project.

## Set up at least one LLM key

Pick whichever you already have. The engine auto-detects the first one set:

| Variable | Provider | Get a key |
| -------- | -------- | --------- |
| `OPENAI_API_KEY` | OpenAI | <https://platform.openai.com/api-keys> |
| `GEMINI_API_KEY` | Google Gemini | <https://aistudio.google.com/apikey> |
| `ANTHROPIC_API_KEY` | Anthropic Claude | <https://console.anthropic.com/settings/keys> |
| `MISTRAL_API_KEY` | Mistral | <https://console.mistral.ai/api-keys/> |
| `GROQ_API_KEY` | Groq | <https://console.groq.com/keys> |
| `OPENAI_COMPATIBLE_BASE_URL` | Ollama / vLLM / OpenRouter / Together / LM Studio | n/a |

You can also pass `apiKey` directly in the `LLMConfig` object (handy when keys come from a vault). See [LLM providers](/guide/llm-providers) for full per-provider notes.

## Verify

```bash
export GEMINI_API_KEY=...   # or any other provider key
npx monkeytest explore https://example.com
```

You should see crawl output, a generated `.monkeytest/sitemap.json`, and screenshots under `.monkeytest/screenshots/`.

If something looks off, head to [Troubleshooting](/guide/troubleshooting).

Next: [Quick start →](/guide/quick-start)
