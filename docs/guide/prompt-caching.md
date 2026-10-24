# Prompt caching

Repeat MonkeyTest runs against the **same site** send a lot of identical context to the planner — the same site map, the same system prompt, the same flow schema. Modern LLM APIs let you cache that prefix, so the second run pays a fraction of the input-token cost.

The engine wires this up automatically for **OpenAI** and **Anthropic**. You don't change anything in your code — caching kicks in once the prompt is large enough.

## At a glance

| Provider | Mechanism | Activation | Notes |
| -------- | --------- | ---------- | ----- |
| **OpenAI** | Automatic prefix cache | Prompt ≥ 1024 tokens | 50% discount on cached tokens. Typical planner prompt: ~6,000 tokens; the site map portion (~5,000) is cached. |
| **Anthropic** | Explicit `cache_control` breakpoints | Engine adds breakpoints automatically | 90% discount on cache reads, 25% surcharge on cache writes. 5-minute TTL. Best ROI when running many flows against the same site. |
| **Gemini** | Not used (no managed prefix cache today) | — | Token usage still reported via `lastUsage`. |
| **Mistral** | Not used today | — | Token usage still reported. |
| **Groq** | Not used today | — | Already cheap; latency wins matter more here. |
| **OpenAI-compatible** | Depends on server | — | Most local servers (Ollama, vLLM) don't expose a managed cache. |

## How the planner uses it

The planner prompt is split into three pieces, in this exact order:

```
┌─────────────────────────────────────────────────────────────┐
│ system    — never changes (instructions, schema, examples)  │  cached
├─────────────────────────────────────────────────────────────┤
│ cacheable — long stable site-map dump for THIS URL          │  cached
├─────────────────────────────────────────────────────────────┤
│ prompt    — tiny per-call payload (maxFlows, includeAuth)   │  uncached
└─────────────────────────────────────────────────────────────┘
```

The first two parts are identical across all planner calls against the same site, so providers cache them on the first call and reuse them on subsequent calls.

Concretely:

- **OpenAI** hashes the message-array prefix. By placing the dynamic part LAST, ~95% of the prompt becomes a stable prefix.
- **Anthropic** uses `cache_control: { type: 'ephemeral' }` markers. The engine places one at the end of the system block and one at the end of the cacheable user block.

## When does this actually pay off?

The cache TTL is short (5 minutes for Anthropic ephemeral, similar for OpenAI). You see savings whenever you:

- **Re-run on every PR** against a deploy preview (planner runs frequently in a short window).
- **Run multiple depths** of the same URL during local dev / iteration.
- **Run scheduled smoke tests** every few minutes against staging.

You **won't** see savings if you run once a day against a different URL each time — the cache evicts before the second call.

## Reading cache stats

Every `LLM` instance exposes `lastUsage` after each call:

```ts
import { Monkey, autoLLMConfig } from '@monkeytestai/monkeytest-core';

const monkey = new Monkey({ llm: autoLLMConfig() });
await monkey.executeAndTriage(url, { /* … */ });

// Inspect the planner LLM directly (advanced):
//   const llm = createLLM({ provider: 'openai', model: 'gpt-4o' });
//   await llm.generateJSON({ ... });
//   console.log(llm.lastUsage);
//   // → { inputTokens: 6234, cachedInputTokens: 5102, outputTokens: 1410 }
```

The same usage object is also emitted on the live `EventBus`:

```ts
events.on(evt => {
  if (evt.type === 'plan.complete' && evt.data?.usage){
    const u = evt.data.usage as { inputTokens?: number; cachedInputTokens?: number };
    if (u.cachedInputTokens){
      console.log(`Cache hit: ${u.cachedInputTokens}/${u.inputTokens} tokens`);
    }
  }
});
```

This is what powers the "saved $X via prompt cache" tooltip in MonkeyTest Cloud.

## Estimating savings

A standard run against the same site, second call within 5 minutes:

| Provider | Without cache | With cache | Saving |
| -------- | ------------- | ---------- | ------ |
| OpenAI `gpt-4o` planner | ~$0.045 | ~$0.027 | **40%** |
| Anthropic `claude-sonnet-4-5` planner | ~$0.18 | ~$0.030 | **83%** |

Anthropic shines here because the cache-read discount is steep (~90%) and the planner prompt is very large.

## When to disable it

You generally don't need to. But if you're chasing reproducibility for a benchmark and want every call to actually invoke the model fresh, send a unique nonce in the `cacheable` block (e.g. a timestamp comment) — that defeats the cache hash for that call.

## Beyond the planner

The triager polish pass (when configured) also benefits from caching: the system prompt is large and stable across all bugs in a run. Anthropic in particular sees a big drop on the second-and-later bugs in a single batch.

The explorer and runner phases don't currently use caching — their prompts are different on every call (different page, different step) and there's no useful prefix to cache.

Next: [Triager polish →](/guide/triager)
