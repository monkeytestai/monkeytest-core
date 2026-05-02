# How it works

MonkeyTest Core is a four-phase pipeline. Each phase is a pure function of its inputs and emits structured events you can subscribe to.

```
URL ─▶ Explorer ─▶ SiteMap ─▶ Planner ─▶ TestPlan ─▶ Runner ─▶ RunResult ─▶ Triager ─▶ RunResult { bugs[] }
        (Playwright +   (LLM)               (LLM)                (Playwright +              (rules + LLM)
         cheap LLM)                                              cheap LLM)
```

Everything else in the package — the CLI, the `EventBus`, `autoLLMConfig`, the typed result objects — is plumbing around this pipeline.

## Phase 1: Explorer

**Goal:** find out what the site is and what's on each page, so the planner has something concrete to plan against.

What it does:

- Launches Chromium via Playwright (headless by default).
- Visits the start URL, waits for the SPA / DOM to settle.
- For each visited page, extracts: `<title>`, visible text, salient interactive elements (forms, buttons, links, inputs, menus), in-domain outbound links.
- Asks the **explorer LLM** to summarise the page in one short paragraph and tag whether it looks auth-gated.
- Optionally screenshots every page to `screenshotsDir` (this becomes evidence for the report).
- Follows in-domain links breadth-first up to `maxPages`.

Output: a `SiteMap` with `pages[]`, `pendingUrls[]`, and `failedUrls[]`. Always returned, even if some pages fail — failures don't kill the run.

Why it matters: this is the **grounding** that prevents the planner from hallucinating selectors that don't exist.

## Phase 2: Planner

**Goal:** propose a small number of high-value user flows, grounded in the site map.

What it does:

- Takes the `SiteMap` and the inferred site type ("ecommerce", "blog", "saas dashboard"…).
- Asks the **planner LLM** for up to `maxFlows` flows, each with: a name, kind (`happy_path`, `edge_case`, `auth_required`, `destructive`, `accessibility`, `visual`), starting URL, ordered steps, and an overall expectation.
- Validates the LLM's JSON against a strict zod schema. Anything that doesn't fit gets rejected, not silently consumed.
- Strips flows that hit auth walls if `includeAuthFlows: false`.

Output: a `TestPlan { flows: TestFlow[] }`. If the planner produces zero flows (e.g., the explorer found nothing useful), the engine short-circuits with `notes` explaining why.

This is the **one place** in the pipeline where you really benefit from a smart model — it's a single, high-stakes call. Use `gpt-4o`, `claude-sonnet-4-5`, `gemini-flash-latest`, or `mistral-large-latest`.

## Phase 3: Runner

**Goal:** actually do the things, capture evidence, never lie about what happened.

What it does:

- For each flow, opens a fresh browser context with **video recording** enabled.
- For each step, asks the **runner LLM** *"to satisfy this step on the current page, what tool should I call with what args?"* — `goto`, `click`, `fill`, `assert_text`, `wait_for_selector`, etc.
- Executes the chosen tool through Playwright with a per-step timeout.
- Takes a screenshot **after every step** (success, failure, or blocked).
- Captures all console errors and failed network requests on the page during the step.
- Classifies the step: `passed` / `failed` / `blocked` / `skipped`. "Soft" misses (text not found, element not located) become `skipped` observations rather than false-positive bugs.
- Renames the per-flow video to a predictable basename so the SaaS server can serve it without a manifest.

Output: a `RunResult` with `flows[].steps[].screenshotPath`, `videoPath`, `consoleErrors[]`, `networkFailures[]`, and per-step `durationMs`.

This phase is **call-volume heavy** (one LLM call per step). Use the cheapest fast model your provider offers — `gpt-4o-mini`, `gemini-flash-lite-latest`, `claude-haiku-4-5`, `llama-3.3-70b-versatile` on Groq.

## Phase 4: Triager

**Goal:** turn raw step failures into stable, deduplicated bug reports.

What it does:

- Groups step failures by flow and root-cause signature.
- Computes a **fingerprint** — a hash of `(affectedFlow, normalised observation, primary error)` — so the same bug across runs gets the same id.
- Picks a severity (`critical` / `major` / `minor`) based on flow severity + step status + evidence.
- Bundles screenshots, console errors, and network failures into a single `BugEvidence`.
- Writes a short, plain-English `triageNotes` for each bug.

Output: the same `RunResult`, with `bugs: BugReport[]` populated. The triager is **deterministic by default**. An optional LLM polish pass is on the roadmap for richer titles.

## Resilience guarantees

The pipeline is intentionally fault-tolerant:

| If this fails… | You still get… |
| -------------- | -------------- |
| Some pages 404 / time out | The pages that did succeed, in the `SiteMap`. |
| The explorer LLM rejects a page | The page is recorded in `failedUrls[]`; crawl continues. |
| The planner LLM throws | The `SiteMap` (with explorer screenshots), an empty plan, and `notes` explaining the failure. |
| A flow blows up mid-execution | Every step that ran, every screenshot taken, the partial `FlowResult`. |
| A single step times out | The screenshot at the moment of failure, plus the rest of the flow's steps marked `blocked`. |

Nothing is "all or nothing". You always get evidence.

## The `EventBus`

Every phase emits structured `LiveEvent`s through an optional `EventBus`. This is what powers MonkeyTest Cloud's live-activity panel and is documented in [Live events](/guide/live-events).

```ts
import { Monkey, EventBus } from '@mtai/monkeytest-core';

const events = new EventBus();
events.on(e => console.log(`[${e.phase}] ${e.type}: ${e.message}`));

await new Monkey({ llm: ... }).executeAndTriage(url, { events, explore: ..., plan: ..., run: ... });
```

Next: [Configuration →](/guide/configuration)
