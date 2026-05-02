# Introduction

**MonkeyTest Core** is a TypeScript library that turns an LLM into an exploratory test agent for your web app. You give it a URL; it gives you back a list of bugs with screenshots.

It runs in **four phases**:

1. **Explore** — Open a real Chromium browser via Playwright, visit pages, summarise what each one does, capture per-page screenshots.
2. **Plan** — Ask an LLM to propose realistic user flows grounded in what was actually seen on the site (no fantasy selectors).
3. **Run** — Execute each flow step by step, recording per-step PNGs, console errors, network failures, and an optional flow video.
4. **Triage** — Convert raw failures into a deduplicated, fingerprinted `BugReport[]` that's stable across runs.

The whole pipeline returns a typed `RunResult` you can serialise, diff, persist, or hand to your own UI.

## Who it's for

- **Frontend devs** who want a sanity check on their staging URL without writing a Playwright suite from scratch.
- **Indie hackers / small teams** who can't justify a dedicated QA engineer but still want eyes on the product before every deploy.
- **Platform / DX teams** building internal QA dashboards and want a reliable engine to embed.
- **Agencies** running quick check-ups across many client sites.

## What you'll get out of a run

- A `SiteMap` — pages visited, summaries, outbound links, screenshot paths.
- A `TestPlan` — flows the LLM thought were worth running, grounded in the site map.
- A `RunResult` — every step's outcome, evidence, and timing, plus a clean bug list.
- A live `EventBus` stream you can wire into a UI in 5 lines.

## What you bring

- **Node.js 20+**
- An **LLM key** for any one of: OpenAI, Gemini, Anthropic, Mistral, Groq, or any OpenAI-compatible endpoint (Ollama, vLLM, OpenRouter, …)
- A URL you want tested

That's it.

## Design principles

- **No DSL.** You write TypeScript or call the CLI. There's no YAML schema to memorise.
- **No fantasy steps.** The planner is constrained to act on things the explorer actually saw.
- **Resilient by default.** If the planner fails, you still get the explorer's screenshots. If a flow blows up, you still get the steps that ran.
- **Hot path is cheap.** Per-step LLM calls use the cheapest model you give them; the smart model is reserved for the one-shot planning call.
- **Observable.** Every phase emits structured events. Your dashboard shouldn't have to parse logs.

Next: [Installation →](/guide/installation)
