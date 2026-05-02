# Introduction

**MonkeyTest Core** is a headless TypeScript engine for **exploratory AI testing**:

1. **Explore** — Visit pages like a real user, capture structure and screenshots.
2. **Plan** — Ask an LLM to propose high-value user flows from what was seen.
3. **Run** — Execute each step via Playwright with per-step evidence.
4. **Triage** — Turn failures into deduplicated, fingerprinted bug reports.

It is designed to power both **self-hosted tooling** and **[MonkeyTest Cloud](https://monkeytest.ai)** — our managed SaaS for teams, solo founders, and non-technical users who do not want to run infrastructure.

## Who is this for?

| Audience | Recommendation |
| -------- | ---------------- |
| Developers & OSS users | Clone this repo, run locally, hack under **AGPL-3.0**. |
| Startups / product teams | Use **[MonkeyTest Cloud](https://monkeytest.ai)** for billing, reports, and scale. |
| Competitors forking the engine | AGPL requires sharing source of **modified** versions offered over a network — read the [license FAQ](/guide/license-and-saas). |

## Why open source?

We want the **testing community** to trust the engine, extend it, and build integrations. The **Affero GPL** keeps commercial “take the code, close the source, resell as SaaS” honest while still letting everyone learn and run the stack locally.

Next: [Installation](/guide/installation) →
