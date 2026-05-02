# Cost & depth

How much does a MonkeyTest run cost? It depends on:

1. **Depth** — how many pages you crawl (`maxPages`) and how many flows you run (`maxFlows × steps`).
2. **Models** — which LLM you give to each phase.
3. **Page size** — bigger pages = bigger explorer prompts.

This page gives you **estimated costs** for the three depth presets (`shallow`, `standard`, `deep`) across all supported providers, plus the assumptions and a calculator so you can plug in your own numbers.

::: tip Token prices change every month
We update this page periodically, but always sanity-check against the provider's pricing page before you budget. Treat these numbers as **order of magnitude**, not invoices.
:::

## Depth presets

| Depth | `maxPages` | `maxFlows` | Avg steps/flow | Total LLM calls |
| ----- | ---------- | ---------- | -------------- | --------------- |
| **Shallow** (smoke) | 4 | 3 | 4 | ~16 (4 explore + 1 plan + 12 run) |
| **Standard** (default) | 8 | 6 | 6 | ~45 (8 + 1 + 36) |
| **Deep** (release) | 16 | 10 | 8 | ~97 (16 + 1 + 80) |

## Token assumptions

Conservative averages from the engine's actual prompts (you can see them all under `monkeytest-core/src/{explorer,planner,runner,triager}/`).

| Phase | Input tokens / call | Output tokens / call |
| ----- | ------------------- | -------------------- |
| Explorer (per page) | ~2,500 | ~250 |
| Planner (one shot) | ~6,000 | ~1,500 |
| Runner (per step) | ~1,500 | ~120 |

So a **standard** run uses roughly:

- Explorer: 8 × (2,500 in + 250 out) = **20,000 in / 2,000 out**
- Planner: 1 × (6,000 in + 1,500 out) = **6,000 in / 1,500 out**
- Runner: 36 × (1,500 in + 120 out) = **54,000 in / 4,320 out**
- **Total ≈ 80k input tokens, 8k output tokens**

A **shallow** run is ~25k in / 2k out. A **deep** run is ~175k in / 17k out.

## Per-provider cost estimates

USD per **standard run** (8 pages, 6 flows, ~6 steps each). Calculated against published list prices as of writing.

| Provider | Cheap-everywhere | Balanced (cheap explorer/runner + smart planner) | Smart-everywhere |
| -------- | ---------------- | ----------------------------------------------- | ---------------- |
| **OpenAI** | `gpt-4o-mini` everywhere → **~$0.02** | `gpt-4o-mini` + `gpt-4o` planner → **~$0.05** | `gpt-4o` everywhere → **~$0.45** |
| **Gemini** | `flash-lite-latest` everywhere → **~$0.01** | `flash-lite-latest` + `flash-latest` planner → **~$0.02** | `flash-latest` everywhere → **~$0.05** |
| **Anthropic** | `claude-haiku-4-5` everywhere → **~$0.08** | `haiku` + `sonnet-4-5` planner → **~$0.18** | `claude-sonnet-4-5` everywhere → **~$0.90** |
| **Mistral** | `mistral-small-latest` everywhere → **~$0.03** | `small` + `large-latest` planner → **~$0.06** | `mistral-large-latest` everywhere → **~$0.18** |
| **Groq** (Llama 3.3 70B) | flat → **~$0.06** | (no separate smart tier) → **~$0.06** | flat → **~$0.06** |
| **Local (Ollama)** | electricity only | electricity only | electricity only |

For shallow runs, divide by ~3. For deep runs, multiply by ~2.5. The smart planner alone accounts for most of the variance — that's the lever to pull when budget matters.

::: warning These are list prices
Volume discounts, batch APIs, prompt-caching (OpenAI / Anthropic) and free tiers can dramatically reduce real costs. Anthropic's prompt caching is especially impactful when you call the planner many times against the same site map.
:::

## Cost calculator

For your own combinations:

```
cost ≈
    (explorer_calls × explorer_in × P_in_explorer + explorer_calls × explorer_out × P_out_explorer)
  + (1             × planner_in  × P_in_planner  + 1              × planner_out  × P_out_planner)
  + (runner_calls  × runner_in   × P_in_runner   + runner_calls   × runner_out   × P_out_runner)
```

Where:

- `explorer_calls` ≈ `maxPages`
- `runner_calls`   ≈ `maxFlows × avg_steps_per_flow`
- `P_in_*`, `P_out_*` are the per-token prices for the model you assigned to that phase.

Example (standard run, mixed setup): Gemini Flash Lite explorer + Claude Sonnet 4.5 planner + Groq Llama runner.

```
explorer:  8 × (2500 × $0.075 + 250 × $0.30)  / 1e6  ≈ $0.0021
planner:   1 × (6000 × $3.00  + 1500 × $15.00) / 1e6 ≈ $0.041
runner:   36 × (1500 × $0.59  + 120  × $0.79)  / 1e6 ≈ $0.035
                                                       ─────────
                                                       ≈ $0.078
```

## Cost-control tips

1. **Lower `maxPages` first.** Halving pages roughly halves explorer cost, and the planner usually has enough info from 4–6 pages.
2. **Lower `maxFlows` second.** This linearly scales runner cost — the largest line item in deep runs.
3. **Use a smart planner, cheap everything else.** This is the single best price/quality trade-off.
4. **Use Groq for the runner.** Hot path, near-zero latency, flat low pricing.
5. **Use prompt caching where supported** (OpenAI gpt-4o, Anthropic). The site map changes per URL; the system prompts don't.
6. **Cap `pageTimeoutMs`** if the explorer is hitting slow pages — wasted seconds = wasted explorer LLM calls when retries fire.
7. **Run locally on Ollama** for development. Quality drops, but cost goes to zero.

## A pragmatic default

For a small team running on every PR:

```ts
import { Monkey, autoLLMConfig } from '@mtai/monkeytest-core';

const monkey = new Monkey({
  llm: autoLLMConfig({
    quality: 'balanced',
    overrides: { runner: { provider: 'groq', model: 'llama-3.3-70b-versatile' } },
  }),
});

await monkey.executeAndTriage(url, {
  explore: { maxPages: 6, screenshotsDir },
  plan:    { maxFlows: 4 },
  run:     { screenshotsDir, headless: true },
});
```

Estimated cost per PR: **~$0.04** with OpenAI keys, or **~$0.02** with Gemini.

Next: [Live events →](/guide/live-events)
