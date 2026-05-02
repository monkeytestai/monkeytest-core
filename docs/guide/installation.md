# Installation

## Requirements

- **Node.js 20+**
- **Playwright Chromium** (installed via CLI below)
- An **LLM API key** — OpenAI and Google Gemini are supported out of the box

## From npm (when published)

```bash
npm install @mtai/monkeytest-core
npx playwright install chromium
```

## From source

```bash
git clone https://github.com/monkeytest-ai/monkeytest-core.git
cd monkeytest-core
npm install
npx playwright install chromium
npm run build
```

## Environment variables

At least one of:

| Variable | Used for |
| -------- | -------- |
| `OPENAI_API_KEY` | OpenAI models (e.g. `gpt-4o-mini`) |
| `GEMINI_API_KEY` or `GOOGLE_API_KEY` | Gemini models (e.g. `gemini-flash-lite-latest`) |

Optional tuning is documented in [Configuration](/guide/configuration).

## Verify

```bash
export OPENAI_API_KEY=sk-...
npx tsx src/cli.ts explore https://example.com
```

You should see crawl output and artefacts under `.monkeytest/`.

Next: [Quick start](/guide/quick-start) →
