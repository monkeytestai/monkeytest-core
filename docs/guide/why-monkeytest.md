# Why monkeytest

A map of nearby open-source and source-available tools, so you can tell whether this repository is the one you want. It is a description of what each project is built to do. It is not a ranking.

**Last updated 23 Oct 2026.** Licenses were checked against each repository's GitHub metadata and, where GitHub reports no SPDX id, against the `LICENSE` file. Feature descriptions were checked against the project README or docs linked below. Star counts are omitted so this page does not go stale. Where something was not in the sources checked that day, the cell says **unknown**.

## What this repository does

[monkeytest-core](https://github.com/monkeytestai/monkeytest-core) is AGPL-3.0-only. You point it at a URL. It crawls a real browser, asks an LLM for flows grounded in that crawl, runs the flows, and writes bugs with stable fingerprints. `rerun` executes the stored plan again. `diff` compares two runs. `run`, `rerun`, and `diff` use exit codes so CI can fail the job. Local models work through any OpenAI-compatible server, including Ollama (`OPENAI_COMPATIBLE_BASE_URL`, provider `openai_compatible`).

Install it with `npm install @monkeytestai/monkeytest-core` ([npm](https://www.npmjs.com/package/@monkeytestai/monkeytest-core), version 0.4.1). The [quick start](/guide/quick-start) also has a clone and a no-key smoke script for contributors. The license summary for this project is on [License](/guide/license). That page is the project's own terms. The table below is only so you can see the other licenses next to it.

## Side by side

| Project | License | What you give it | What you get back | Local models |
| --- | --- | --- | --- | --- |
| [monkeytest-core](https://github.com/monkeytestai/monkeytest-core) | AGPL-3.0-only | A URL | Crawl → plan → run → fingerprinted bugs, then `rerun` and `diff`, with CI exit codes | Yes. OpenAI-compatible servers (Ollama, vLLM, LM Studio) |
| [Explorbot](https://github.com/testomatio/explorbot) | Elastic License 2.0 (source-available) | A URL, plus a provider key | Autonomous exploration, and Playwright or CodeceptJS tests you can keep, with reports and screencasts | Unknown. Documented setup is hosted providers through the Vercel AI SDK |
| [browser-use](https://github.com/browser-use/browser-use) | MIT | A task | A Python browser agent that carries out the task. The repository also describes a hosted cloud | Unknown |
| [Skyvern](https://github.com/Skyvern-AI/skyvern) | AGPL-3.0 | A browser workflow | Workflow automation ("Automate browser based workflows with AI", from the repository description) | Unknown |
| [Stagehand](https://github.com/browserbase/stagehand) | MIT | SDK calls (`act`, `extract`, `observe`) inside your own script | Browser primitives, plus action caching (Browserbase server cache and a local cache directory). Their docs describe caching; this page did not re-run it | Unknown as a default. `act` accepts a model `baseURL`, so a custom endpoint is possible |
| [Midscene.js](https://github.com/web-infra-dev/midscene) | MIT | YAML cases or JavaScript calls you write | Vision-driven UI actions and assertions on web, mobile, and desktop | Yes. The README lists self-hosted and open-source vision models (Qwen, UI-TARS, and others) alongside hosted models |
| [Shortest](https://github.com/antiwork/shortest) | MIT | Natural-language tests you write (`shortest("…")`) | Playwright execution of those tests | The README checked on this date documents Anthropic (`ai.provider: "anthropic"`). Other providers were not listed there |
| [Gremlins.js](https://github.com/marmelab/gremlins.js) | MIT | A page, and a script that unleashes gremlins | Random clicks, typing, and form fills. No LLM and no plan | None. There is no model |

### Notes that did not fit the cells

- **Explorbot**'s GitHub license API returns `NOASSERTION`, because Elastic License 2.0 is not an SPDX id. The `LICENSE` file in the repository is Elastic License 2.0. The README states a restriction on offering Explorbot itself as a hosted or managed service, and states that using it to test your own applications is allowed. Explorbot's README asks for Node.js 24+ or Bun. This repository asks for Node.js 20+.
- **Explorbot** also describes API testing from an OpenAPI spec. That is outside the browser loop in the table.
- **Stagehand** is a toolkit you call from your tests. It does not, by itself, crawl a site and hand back a fingerprinted bug list.
- **Midscene.js** tests are authored (YAML or JS). The model decides how to act on what it sees. The README's model list includes models you can self-host.
- **Shortest** tests are also authored, one English sentence at a time, and the documented provider is Anthropic.
- **Gremlins.js** is the older meaning of "monkey testing": random actions, no model. The name overlaps with this project. The mechanism does not.
- **browser-use** is the Python task agent in this list. The others above are TypeScript or JavaScript, except where a project also ships other SDKs (Midscene documents additional language ports maintained elsewhere).

## Choosing

| You want… | Look at |
| --- | --- |
| A URL in, a stored plan, fingerprinted bugs, and a rerun/diff you can gate in CI | monkeytest-core |
| Exploration that emits a Playwright or CodeceptJS suite | Explorbot |
| A Python agent that takes a task | browser-use |
| Browser workflow automation | Skyvern |
| `act` / `extract` calls and action caching inside a script you already have | Stagehand |
| YAML or JS vision tests, including a local vision model | Midscene.js |
| Natural-language tests on Anthropic | Shortest |
| Random actions and no model bill | Gremlins.js |

License is part of the choice. monkeytest-core and Skyvern are AGPL-3.0. Explorbot is Elastic License 2.0. The other rows in the table are MIT. Read the license you would actually ship under. For this repository, start with [License](/guide/license).

Next: [Quick start](/guide/quick-start) · [The bug-finding loop](/guide/the-bug-finding-loop)
