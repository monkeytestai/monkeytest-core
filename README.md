<p align="center">
  <img src="docs/public/logo.svg" alt="MonkeyTest Core" width="96" height="96" />
</p>

<h1 align="center">MonkeyTest Core</h1>

<p align="center">
  <strong>Open-source AI exploratory testing engine</strong><br />
  Playwright · LLM planning · Live events · TypeScript
</p>

<p align="center">
  <a href="https://www.gnu.org/licenses/agpl-3.0"><img src="https://img.shields.io/badge/License-AGPL%20v3-blue.svg" alt="AGPL-3.0" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node 20+" /></a>
  <a href="https://docs.monkeytest.ai"><img src="https://img.shields.io/badge/docs-docs.monkeytest.ai-7c3aed" alt="Documentation" /></a>
  <a href="https://monkeytest.ai"><img src="https://img.shields.io/badge/Cloud%20SaaS-monkeytest.ai-0f172a" alt="MonkeyTest Cloud" /></a>
</p>

---

**MonkeyTest Core** crawls a real browser session over your app, asks an LLM which user journeys matter, executes those flows step-by-step with **screenshots and evidence**, and triages failures into structured bug reports.

| I am a… | Best path |
| ------- | --------- |
| **Developer** who wants to hack, fork, or self-host | You’re in the right repo. **AGPL-3.0** — see [license FAQ](https://docs.monkeytest.ai/guide/license-and-saas.html). |
| **Founder / PM / non-dev** who wants tests without running code | Use **[MonkeyTest Cloud](https://monkeytest.ai)** — same engine, zero ops. |
| **Another SaaS** thinking of reselling a fork | AGPL is intentional. Read the FAQ and talk to a lawyer before you ship. |

📚 **Full documentation:** [docs.monkeytest.ai](https://docs.monkeytest.ai)

---

## Why AGPL-3.0?

We want the engine **inspectable and improvable** by the community, while making it hard for competitors to **proprietary-fork** the product without giving back. The **Affero** clause matters when you run **modified** code as a **network service**.

Using **MonkeyTest Cloud** is the supported way to get a managed product without operating this repo yourself.

---

## Features

- **Explorer** — Chromium + Playwright; per-page summaries and screenshots  
- **Planner** — Flows grounded in what was actually seen (no fantasy selectors)  
- **Runner** — Deterministic step execution; per-step PNGs; optional flow video  
- **Triager** — Deduped `BugReport`s with fingerprints and evidence  
- **`EventBus`** — Stream live progress to your own dashboard ([docs](https://docs.monkeytest.ai/guide/live-events.html))  

---

## Quick start

```bash
git clone https://github.com/monkeytest-ai/monkeytest-core.git
cd monkeytest-core
npm install
npx playwright install chromium
npm run build

export OPENAI_API_KEY=sk-...
node dist/cli.js explore https://example.com
```

Or programmatically:

```ts
import { Monkey, EventBus } from '@mtai/monkeytest-core';

const events = new EventBus();
events.on((e) => console.log(e.message));

const monkey = new Monkey({
  llm: {
    explorer: { provider: 'openai', model: 'gpt-4o-mini', apiKey: process.env.OPENAI_API_KEY! },
    planner:  { provider: 'openai', model: 'gpt-4o-mini', apiKey: process.env.OPENAI_API_KEY! },
  },
});

const { run } = await monkey.executeAndTriage('https://example.com', {
  events,
  explore: { maxPages: 8, screenshotsDir: '.monkeytest/screenshots' },
  plan:    { maxFlows: 4 },
  run:     { screenshotsDir: '.monkeytest/screenshots', headless: true },
});
```

---

## Documentation site (this repo)

```bash
npm run docs:dev      # local preview
npm run docs:build    # static output → docs/.vitepress/dist
```

Deploy that folder to **docs.monkeytest.ai** (see [docs/DEPLOY.md](./docs/DEPLOY.md)).

---

## Contributing

Issues and PRs welcome. By contributing, you agree your work is licensed under **AGPL-3.0** — see [CONTRIBUTING.md](./CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

---

## Security

Report vulnerabilities privately: see [SECURITY.md](./SECURITY.md).

---

## License

Copyright © MonkeyTest and contributors. Licensed under the **GNU Affero General Public License v3.0** — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

`SPDX-License-Identifier: AGPL-3.0-only`
