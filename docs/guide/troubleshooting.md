# Troubleshooting

A grab bag of the most common errors and how to fix them. If your problem isn't here, [open an issue](https://github.com/monkeytestai/monkeytest-core/issues) — and please include the failing event from the `EventBus` (`engine.error` events have a `data.error` field).

## Engine

### `Executable doesn't exist at /path/to/chromium`

You haven't installed Playwright's browsers yet.

```bash
npx playwright install chromium
```

In CI, use `--with-deps` so the system libs come along:

```bash
npx playwright install --with-deps chromium
```

If you set a custom location via `PLAYWRIGHT_BROWSERS_PATH`, make sure that env var is set in **both** the install step and the run step.

### `pages visited: 0`

The explorer reached the URL but couldn't extract anything useful. Common causes:

1. **SPA hasn't hydrated yet.** Increase `pageTimeoutMs` (default 20s). Some apps need 30–60s on a cold cache.
2. **The site blocks headless browsers** (Cloudflare, etc.). Try `headless: false` to confirm.
3. **The URL needs auth.** Auth-gated start URLs are not supported out of the box; point at a logged-out page or a deep link that does work logged out.

### `Planner produced no flows`

The planner LLM looked at the site map and decided there was nothing actionable. Usually because the explorer found very little (see above) or because the model is too cheap to plan well.

Quick fix:

```ts
{ planner: { provider: 'anthropic', model: 'claude-sonnet-4-5' } }   // or gpt-4o
```

### `response did not match schema`

The LLM produced JSON, but it didn't fit the planner / runner schema. The error message includes the zod path of the field that failed.

If it's intermittent, try a smarter model. If it's persistent, please file a bug — schema drift on a popular model is something we want to fix at the engine level.

## Provider-specific

### Gemini: `404 Not Found … is not found for API version v1beta`

Your API key doesn't have access to that pinned model id. Use a `*-latest` alias:

```ts
{ provider: 'gemini', model: 'gemini-flash-lite-latest' }
```

You can list what your key can see:

```bash
curl "https://generativelanguage.googleapis.com/v1beta/models?key=$GEMINI_API_KEY"
```

### Gemini: `503 Service Unavailable`

Gemini Flash occasionally returns "model is currently experiencing high demand". Retry, or switch the planner tier to a different provider:

```ts
{ explorer: { provider: 'gemini' }, planner: { provider: 'openai', model: 'gpt-4o' } }
```

### OpenAI: `401 Unauthorized` or `Invalid API key`

Either `OPENAI_API_KEY` isn't set in the process running the engine, or the key has been revoked. The error message labels the provider — if it says `[gemini:gpt-4o-mini]`, you've passed an OpenAI model id to the Gemini provider. The fix is to set `provider: 'openai'`.

### Anthropic: response is wrapped in prose

Claude doesn't have a true JSON mode, so the engine uses a strong system instruction + defensive parsing. If you still see a parse error, increase `temperature: 0` for that tier (the default 0.2 is usually fine).

### Mistral / Groq: model id rejected

Both providers cycle their hosted model list more aggressively than OpenAI/Anthropic. Check the current list:

- Groq: <https://console.groq.com/docs/models>
- Mistral: <https://docs.mistral.ai/getting-started/models/>

### Ollama / LM Studio: bad JSON or `response_format` not supported

The engine auto-disables `response_format` for `localhost` / `127.0.0.1` endpoints, but if you're running Ollama on another host you can force JSON mode off by serving via a reverse proxy at `localhost`, or use a more capable open model (`llama3.1:70b`, `qwen2.5-coder:32b`).

## Reports / SaaS integration

### Screenshots aren't loading in my report UI

Two things to check:

1. **Cross-origin headers.** The engine writes screenshots to a directory you control; make sure your HTTP server sets `Cross-Origin-Resource-Policy: cross-origin` and `Access-Control-Allow-Origin: *` on those responses.
2. **Path resolution.** `StepResult.screenshotPath` is an **absolute path** on the runner machine. Convert it to a URL your client can fetch (a static mount, or a `/screenshots/:basename` route) before serializing the result.

### The `EventBus` is firing but nothing reaches my UI

You probably attached the listener after starting the run:

```ts
const bus = new EventBus();
const promise = monkey.executeAndTriage(url, { events: bus, ... }); // started

bus.on(...);                                                         // too late
```

Listeners are fine to add late, but you'll miss every event before they were registered. Attach **first**, then start the run.

## Performance

### Runs are slow

In rough order of impact:

1. **Use Groq for the runner.** Per-step LLM calls dominate latency.
2. **Lower `stepTimeoutMs`.** The default 15s is conservative; 5–10s catches most real bugs without long waits.
3. **Lower `maxPages` and `maxFlows`.** Each is a multiplier.
4. **Run flows with no video** by directing `screenshotsDir` to `tmpfs` if you don't need persistent recordings.

### Memory grows over many runs

Make sure you're not retaining the full `RunResult` in memory across runs. The `siteMap.pages[].screenshotPath` and per-step screenshots live on disk; the in-memory result only holds paths, but if you're appending every run to an array, that array will grow.

## Still stuck?

- Check the [examples in Recipes](/guide/recipes).
- Search [GitHub issues](https://github.com/monkeytestai/monkeytest-core/issues).
- Open an issue with: engine version (`monkeytest --version` or `package.json`), Node version, the exact `LLMConfig` you used, and the failing `engine.error` event.

Next: [Live events →](/guide/live-events)
