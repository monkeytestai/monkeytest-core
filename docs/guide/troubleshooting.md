# Troubleshooting

A grab bag of the most common errors and how to fix them. If your problem isn't here, [open an issue](https://github.com/monkeytestai/monkeytester/issues) — and please include the failing event from the `EventBus` (`engine.error` events have a `data.error` field).

## First-run failures

### `dist/` has no `.js` files after `npm run build`

`tsc` can exit 0 and still leave you with nothing to run. On commits that shipped a TypeScript incremental cache (`.tsbuildinfo`) without `dist/`, a fresh `npm run build` wrote declaration files only (`.d.ts`, `.d.ts.map`) and no `.js`. `node scripts/smoke.mjs` then fails importing `dist/explorer/index.js`, and `node dist/cli.js` fails the same way.

```bash
npm run clean && npm run build
test -f dist/cli.js && test -f dist/index.js
```

Current source removes `.tsbuildinfo` at the start of `npm run build`, gitignores that file, and compiles with incremental mode off, so a clone of this version emits JavaScript on the first build. Use the `clean` command above if you still see a declaration-only `dist/`.

### `No LLM provider configured` (exit 2)

The CLI checks the environment before it launches Chromium. With no key and no `OPENAI_COMPATIBLE_BASE_URL`, `run`, `explore`, and `rerun` print this and exit 2:

```text
No LLM provider configured. Set one of: GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, MISTRAL_API_KEY, GROQ_API_KEY, or OPENAI_COMPATIBLE_BASE_URL — or pass --provider explicitly.
```

Export the variable in the same shell, or pass `--provider` and `--api-key`. `node scripts/smoke.mjs` does not go through this check.

### Invalid or revoked API key (exit 3, after the crawl)

A key that is present but rejected is not checked up front. The constructor only checks that a string exists. The provider sees the key on the first model call, which happens after Playwright has already opened the page.

What you see with a bad `GEMINI_API_KEY`:

1. The CLI prints `visited` for the page.
2. A PNG is already in `.monkeytest/shots/` (for example `shots/page-1-example-com.png`).
3. The process then exits **3**. `plan.json` is not written, because the failure is the crawl's closing site summary (`explorer.summariseSite`), before the CLI saves anything.

The message is the provider body, wrapped by the client. For Gemini it looks like this (the JSON is Google's, not ours):

```text
✗ monkeytest failed: [gemini:gemini-flash-lite-latest · explorer.summariseSite] generateContent failed: [GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent: [400 Bad Request] API key not valid. Please pass a valid API key. [… "reason":"API_KEY_INVALID" …]
```

`run` and `explore` both hit that path. OpenAI-compatible providers wrap the same moment as `chat.completions failed:` plus the server's body. `MONKEYTEST_DEBUG=1` adds the stack trace. Fix the key and run again. Per-page summaries that fail are kept (the visit line may say `LLM summary unavailable`); the site-level summary is what aborts the command.

### `Executable doesn't exist` / Chromium missing

Playwright's browser is a separate download from `npm install`. See the next section.

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
2. **Path resolution.** `StepResult.screenshotPath` is an **absolute path** on the runner machine (under `.monkeytest/shots/` when you use the CLI). Convert it to a URL your client can fetch before serializing the result.

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
- Search [GitHub issues](https://github.com/monkeytestai/monkeytester/issues).
- Open an issue with: engine version (`monkeytest --version` or `package.json`), Node version, the exact `LLMConfig` you used, and the failing `engine.error` event.

Next: [Live events →](/guide/live-events)
