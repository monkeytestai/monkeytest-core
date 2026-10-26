# LLM providers

monkeytester ships first-class support for **six provider families**, and lets you mix providers across phases. Every phase (`explorer`, `planner`, `runner`) takes its own `LLMConfig`, so you can — for example — use Anthropic for the smart planning call and Groq for the cheap per-step runner calls.

```ts
new Monkey({
  llm: {
    explorer: { provider: 'gemini',    model: 'gemini-flash-lite-latest' },
    planner:  { provider: 'anthropic', model: 'claude-sonnet-4-5' },
    runner:   { provider: 'groq',      model: 'llama-3.3-70b-versatile' },
  },
});
```

## Supported providers

| Provider | `provider` value | Env var for key | JSON mode |
| -------- | ---------------- | --------------- | --------- |
| OpenAI | `openai` | `OPENAI_API_KEY` | Native |
| Google Gemini | `gemini` | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | Native (`responseMimeType`) |
| Anthropic Claude | `anthropic` | `ANTHROPIC_API_KEY` | Prompted + parsed |
| Mistral | `mistral` | `MISTRAL_API_KEY` | Native (`responseFormat`) |
| Groq | `groq` | `GROQ_API_KEY` | Native (OpenAI-compatible) |
| OpenAI-compatible | `openai_compatible` | `OPENAI_COMPATIBLE_API_KEY` + `OPENAI_COMPATIBLE_BASE_URL` | Per-server (auto-detected for local) |

All providers go through a single `LLM` interface. The engine handles defensive JSON parsing, markdown-fence stripping, schema validation (zod), and consistent error messages so you can swap providers without changing your code.

## Recommended models per provider

These defaults are baked into `autoLLMConfig()` and used as fallbacks when you don't pass `model`. Updated as providers ship cheaper / smarter tiers.

### Cheap & fast (good for `explorer` and `runner`)

| Provider | Default `model` | Why |
| -------- | ---------------- | --- |
| OpenAI | `gpt-4o-mini` | Best $/quality in the OpenAI lineup. |
| Gemini | `gemini-flash-lite-latest` | Cheapest current-gen Google model; ~$0.075/M in. |
| Anthropic | `claude-haiku-4-5` | Latest Haiku tier. |
| Mistral | `mistral-small-latest` | Cheap, fast, great structured-output behaviour. |
| Groq | `llama-3.3-70b-versatile` | 70B Llama at ~500 tps via Groq. |
| OpenAI-compatible | `gpt-4o-mini` | Whatever your endpoint exposes. |

### Smart (good for `planner`)

| Provider | Default `model` | Why |
| -------- | ---------------- | --- |
| OpenAI | `gpt-4o` | Reliable JSON, broadly available. |
| Gemini | `gemini-flash-latest` | The "smarter" Flash tier. |
| Anthropic | `claude-sonnet-4-5` | Best reasoning-per-dollar in the Claude lineup. |
| Mistral | `mistral-large-latest` | Strong planner for the price. |
| Groq | `llama-3.3-70b-versatile` | (Groq doesn't ship a "smarter" tier today; same model.) |
| OpenAI-compatible | `gpt-4o` | Whatever your endpoint exposes. |

You can always pass an explicit `model` to override these.

## Per-provider notes

### OpenAI

The most boring, most reliable choice.

```ts
{ provider: 'openai', model: 'gpt-4o-mini', apiKey: process.env.OPENAI_API_KEY }
```

- Uses `chat.completions.create` with `response_format: { type: 'json_object' }`.
- The default model can also be set via `OPENAI_MODEL`.

### Google Gemini

Cheapest of the hosted options. Watch out for two quirks:

- **Use floating aliases.** Pinned ids like `gemini-2.0-flash-lite` may 404 for new keys; the `*-latest` aliases (`gemini-flash-lite-latest`, `gemini-flash-latest`) are the most reliable.
- **503s under load.** Gemini Flash occasionally returns "model is currently experiencing high demand". Combine with another provider for the planner if this is critical.

```ts
{ provider: 'gemini', model: 'gemini-flash-lite-latest' }
```

### Anthropic Claude

Best reasoning quality on the planner tier; we strongly recommend it for `planner`.

```ts
{ provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: process.env.ANTHROPIC_API_KEY }
```

- Claude doesn't have a true "JSON mode", so the engine uses a strong system instruction plus defensive parsing.
- You can also use `claude-haiku-4-5` for the runner tier.

### Mistral

European hosting, cheap small models, decent structured-output behaviour.

```ts
{ provider: 'mistral', model: 'mistral-small-latest', apiKey: process.env.MISTRAL_API_KEY }
```

- Uses Mistral's native `responseFormat: { type: 'json_object' }`.
- `mistral-large-latest` is a fine planner if you're price-sensitive.

### Groq

Not a model — a fast OpenAI-compatible serving layer for open-weights models. Routes the engine's calls through Groq's `/openai/v1` endpoint at near-instant latency.

```ts
{ provider: 'groq', model: 'llama-3.3-70b-versatile' }
```

- Uses the Groq `https://api.groq.com/openai/v1` base URL automatically.
- Excellent for the **runner** tier (low latency = faster runs).
- Make sure your model id is one Groq currently serves — see [console.groq.com/docs/models](https://console.groq.com/docs/models).

### OpenAI-compatible (Ollama, vLLM, OpenRouter, Together, LM Studio…)

Anything that speaks the OpenAI Chat Completions API.

```ts
{
  provider: 'openai_compatible',
  baseURL:  'http://127.0.0.1:11434/v1',   // Ollama
  apiKey:   'ollama',                       // any non-empty string
  model:    'llama3.1:8b',
}
```

From the CLI, after `npm run build` in a clone:

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

Env vars the client actually reads (`src/llm/index.ts`, `src/llm/presets.ts`):

| Variable | Role |
| --- | --- |
| `OPENAI_COMPATIBLE_BASE_URL` | Endpoint. Also the fallback when `--base-url` is omitted. Auto-detect selects this provider only when this variable is set and no hosted key is set. |
| `OPENAI_COMPATIBLE_API_KEY` | Sent as the bearer token. Ollama ignores it. If both this and `--api-key` are unset, the client uses `sk-no-key-required`. |

Pass `--model`. The default model id for `openai_compatible` is `gpt-4o-mini`, which Ollama does not serve. JSON mode (`response_format`) is disabled when the base URL matches `ollama`, `localhost`, or `127.0.0.1`. The copy-paste walkthrough is on the [quick start](/guide/quick-start#fully-local-with-ollama).

```ts
// OpenRouter
{
  provider: 'openai_compatible',
  baseURL:  'https://openrouter.ai/api/v1',
  apiKey:   process.env.OPENROUTER_API_KEY,
  model:    'anthropic/claude-sonnet-4.5',
}
```

```ts
// Together
{
  provider: 'openai_compatible',
  baseURL:  'https://api.together.xyz/v1',
  apiKey:   process.env.TOGETHER_API_KEY,
  model:    'meta-llama/Llama-3.3-70B-Instruct-Turbo',
}
```

The engine auto-disables `response_format` for local servers (Ollama / LM Studio) where it's commonly not supported, and falls back to defensive JSON extraction.

## Mixing providers

A common production setup:

```ts
new Monkey({
  llm: {
    // Cheap and fast — many calls
    explorer: { provider: 'gemini', model: 'gemini-flash-lite-latest' },

    // One-shot, high stakes — pay for intelligence
    planner:  { provider: 'anthropic', model: 'claude-sonnet-4-5' },

    // Hot path — many calls again
    runner:   { provider: 'groq', model: 'llama-3.3-70b-versatile' },
  },
});
```

This costs roughly the same as "Gemini Flash everywhere" but produces noticeably better test plans because the planner step is the one that matters most.

## Auto-detect from env

Don't want to think about any of this for your first run?

```ts
import { Monkey, autoLLMConfig } from '@monkeytestai/monkeytester';

new Monkey({ llm: autoLLMConfig({ quality: 'balanced' }) });
```

It picks the first env var it finds in the order `GEMINI → OPENAI → ANTHROPIC → MISTRAL → GROQ → OPENAI_COMPATIBLE` and uses sensible cheap/smart defaults. See [Configuration](/guide/configuration) for the exact behaviour.

Next: [Cost & depth →](/guide/cost-and-depth)
