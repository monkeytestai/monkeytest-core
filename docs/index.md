---
layout: home

hero:
  name: monkeytester
  text: An AI agent that uses your site like a real user — and reports the bugs.
  tagline: Open-source. Playwright + your favourite LLM. Zero glue code. Built for devs who'd rather ship than write yet another Selenium script.
  image:
    src: /hero.jpg
    alt: An open library of intelligence with a stylised AI monkey agent inspecting a webpage and pinning a bug
  actions:
    - theme: brand
      text: Get started in 60 seconds
      link: /guide/quick-start
    - theme: alt
      text: How it works
      link: /guide/architecture
    - theme: alt
      text: GitHub
      link: https://github.com/monkeytestai/monkeytester

features:
  - title: Drop-in, not framework
    icon: 🧰
    details: One library, one constructor. No Selenium grids, no test DSL, no YAML — just `await monkey.executeAndTriage(url)`. Install with `npm install @monkeytestai/monkeytester`.
  - title: Bring your own LLM
    icon: 🧠
    details: OpenAI, Gemini, Anthropic, Mistral, Groq, or any OpenAI-compatible endpoint (Ollama, vLLM, OpenRouter). Pick a different model per phase.
  - title: Real evidence, not log dumps
    icon: 📸
    details: Per-step screenshots, optional WebM video, console + network failures, and a deduplicated bug report with stable fingerprints.
  - title: Live activity stream
    icon: 📡
    details: Subscribe to an EventBus and pipe explorer / planner / runner / triager events into your own dashboard or CLI.
  - title: Predictable, hackable, typed
    icon: 🔬
    details: Pure TypeScript, zod-validated LLM output, structured `RunResult` you can serialise, diff, and store. No magic.
  - title: AGPL & community-first
    icon: 🤝
    details: Free for everyone to use, fork, and self-host. The Affero clause keeps modifications shareable when run as a service.
---

<style>
.vp-doc h2 + p { font-size: 1.0625rem; }
</style>

::: info Install
`npm install @monkeytestai/monkeytester` (version 0.6.0, [npm](https://www.npmjs.com/package/@monkeytestai/monkeytester)). The [quick start](/guide/quick-start) also covers a clone and a no-key smoke test. A side-by-side with other tools is on [Why monkeytest](/guide/why-monkeytest).
:::

## Why monkeytester?

Most QA tools ask you to **write tests**. monkeytester writes its own — by **looking** at your app first. How that compares with Explorbot, browser-use, Skyvern, Stagehand, Midscene.js, Shortest, and Gremlins.js is on [Why monkeytest](/guide/why-monkeytest).

It opens a real browser, crawls a few pages, asks an LLM *"what would a real user try here?"*, runs those flows step by step, and hands you back a structured report with screenshots, bug fingerprints, and a live event stream you can wire into your own dashboard.

```ts
import { Monkey, autoLLMConfig } from '@monkeytestai/monkeytester';

const monkey = new Monkey({ llm: autoLLMConfig({ quality: 'balanced' }) });

const { run } = await monkey.executeAndTriage('https://example.com', {
  explore: { maxPages: 8, screenshotsDir: '.monkeytest/shots' },
  plan:    { maxFlows: 4 },
  run:     { screenshotsDir: '.monkeytest/shots' },
});

console.log(`${run.bugs.length} bug(s) found across ${run.stats.flowsTotal} flows`);
```

That's it. No fixtures, no page objects, no recorders.

## Where it shines

- **Pre-release sanity checks** — point it at a staging URL and let it find the obvious "the form doesn't submit" / "checkout 500s" issues before a human does.
- **PR previews** — run on Vercel/Netlify preview URLs in CI, fail the check if a flow regresses.
- **Daily smoke runs against prod** — cheap LLM tier, screenshots stored as artefacts.
- **Embedding in your own product** — the engine is a library, not a CLI. Wrap it in your own SaaS, internal tool, or VS Code extension.

## What it isn't

- Not a replacement for **deterministic critical-path E2E tests** — it's a complement.
- Not a **load tester** or **a11y auditor** (those exist; pair them).
- Not magic — quality of bug reports tracks the quality of the LLM you give it.

## Don't want to run it yourself?

[**MonkeyTest Cloud**](https://monkeytest.ai) is the same engine, fully managed, with hosted browsers, history, dashboards, and team accounts. Use the OSS engine for hacking and self-hosting; use Cloud when you want it to "just run".

[Get started →](/guide/quick-start)
