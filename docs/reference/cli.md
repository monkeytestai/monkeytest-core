# CLI reference

The `monkeytest` binary ships in [`@monkeytestai/monkeytester`](https://www.npmjs.com/package/@monkeytestai/monkeytester) **0.6.0**:

```bash
npm install @monkeytestai/monkeytester
npx monkeytest --help
```

`npm install -g @monkeytestai/monkeytester` puts `monkeytest` on your PATH. From a clone, the same binary is `dist/cli.js`:

```bash
git clone https://github.com/monkeytestai/monkeytester.git
cd monkeytester
npm install && npm run build
node dist/cli.js --help
```

All commands write to `./.monkeytest/` by default (override with `--dir`).

## Commands

### `monkeytest init`

Scaffold a `.monkeytest/` directory with `config.json`, `runs/`, `shots/`, and a `.gitignore` that ignores `shots/` and `runs/`. Idempotent — an existing `config.json` is left in place.

```bash
node dist/cli.js init
# ✓ Initialised .monkeytest/
#   Tracked:    config.json, plan.json (after first run)
#   Ignored:    shots/, runs/
```

`config.json` is a starter file. The CLI does not read it on `explore`, `run`, `rerun`, `diff`, or `report`. Provider, model, quality, and limits come from flags and environment variables. The file's `$schema` field points at `https://docs.monkeytest.ai/config-schema-v1.json`, and that URL 404s — there is no published JSON Schema. Editors may warn. Delete the `$schema` line, or delete the file, if the warning gets in the way. Nothing in the engine fetches it.

### `monkeytest explore <url>`

Crawl the site, summarise pages with the LLM, and generate a `TestPlan`. Writes `plan.json` and `sitemap.json`. **Does not** execute any flows.

```bash
monkeytest explore https://example.com --max 12 --flows 8
```

Useful when you want to inspect the plan before running it (or commit it before a CI rerun).

### `monkeytest run <url>`

Full pipeline: explore + plan + run + triage. Writes:

- `plan.json` — the generated `TestPlan`
- `runs/<timestamp>.json` — the `RunResult` (flows, bugs, stats)
- `shots/page-*.png` — explorer screenshots
- `shots/flow-*-step-*-*.png` — per-step screenshots
- `shots/flow-*.webm` — per-flow video recordings

Exits **`1`** if any non-`minor` bug is found, so CI can gate on it.

```bash
monkeytest run https://example.com --quality balanced
```

### `monkeytest rerun [<runId>]`

Re-execute the **same stored plan** (skip explore + plan). The cheap, fast, deterministic path for verifying that a fix landed.

```bash
monkeytest rerun                      # uses .monkeytest/plan.json
monkeytest rerun 2026-05-02T10-15-00Z # use the plan stored alongside this run
```

Exits **`1`** if any blocking bug is still failing.

### `monkeytest diff <runA> <runB>`

Set diff over bug fingerprints. `<runA>` / `<runB>` are stored run ids, or the shortcuts `latest` and `prev`.

```bash
monkeytest diff prev latest
#
# Diff 2026-05-02T08-00-00Z → 2026-05-02T13-30-00Z
#   1 new, 2 fixed, 1 still broken, 0 regressed (net -1)
#
#   New bugs (1)
#     [critical] Checkout returns 500
#            fingerprint: fp-checkout-500
#   Fixed bugs (2)
#     [major]    Login button does not respond
#     [minor]    Footer typo
#   Still broken (1)
#     [major]    Search slow
```

Exits **`1`** if there are new bugs **or** any severity escalation.

### `monkeytest report [<runId>]`

Pretty-print a stored run — flows, bugs, evidence paths.

```bash
monkeytest report          # latest
monkeytest report --json   # machine-readable
```

### `monkeytest help [<command>]`

Top-level or per-command help.

### `monkeytest version`

Print the engine version.

## Common flags

| Flag                    | Default        | What                                                                  |
| ----------------------- | -------------- | --------------------------------------------------------------------- |
| `-d, --dir <path>`      | `.monkeytest`  | Working directory                                                     |
| `--provider <id>`       | auto-detect    | `openai` \| `gemini` \| `anthropic` \| `mistral` \| `groq` \| `openai_compatible` |
| `--model <id>`          | provider best  | Specific model id                                                     |
| `--api-key <key>`       | env var        | Override the env API key                                              |
| `--base-url <url>`      | —              | Required for `openai_compatible` (Ollama, vLLM, OpenRouter, …)        |
| `--quality <preset>`    | `balanced`     | `cheap` \| `balanced` \| `smart` (used by `autoLLMConfig`)            |
| `--depth <preset>`      | —              | `basic` (Quick pass) \| `standard` \| `deep` \| `shallow`. `basic` crawls at most 6 pages and plans 4 flows, biased to forms, search, and primary CTAs. `--max` and `--flows` override the preset. |
| `-m, --max <n>`         | `8`            | Max pages to crawl (`run`, `explore`). A few slots are reserved for help, contact, support, and about links the crawl actually saw. |
| `--flows <n>`           | `6`            | Max flows to plan. A crawled public form, one enabled button, one link to a page that was not crawled, and one disabled button each keep a grounded flow when the budget allows. |
| `--fail-on-5xx`         | on             | Fail a step that saw a same-origin HTTP ≥500 (document, xhr, or fetch) and report a blocking bug. `new Monkey()` defaults this on too. |
| `--no-fail-on-5xx`      |                | Leave those 5xx responses as evidence on the step. Library callers pass `failOn5xx: false`. |
| `--no-headless`         | headless       | Show the browser window                                               |
| `--label <text>`        | —              | Free-form label saved on the plan/run                                 |
| `--json`                | text           | Machine-readable output (`run`, `diff`, `report`)                     |

## Environment variables

| Variable                          | Used for                                          |
| --------------------------------- | ------------------------------------------------- |
| `OPENAI_API_KEY`                  | OpenAI provider                                   |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | Google Generative AI                            |
| `ANTHROPIC_API_KEY`               | Anthropic Claude                                  |
| `MISTRAL_API_KEY`                 | Mistral                                           |
| `GROQ_API_KEY`                    | Groq                                              |
| `OPENAI_COMPATIBLE_BASE_URL`      | Self-hosted (Ollama, vLLM, LM Studio, OpenRouter) |
| `OPENAI_COMPATIBLE_API_KEY`       | Optional key for the OpenAI-compatible endpoint   |
| `MONKEYTEST_DEBUG`                | Print stack traces on failure                     |

## Exit codes

| Code | Meaning                                         |
| ---- | ----------------------------------------------- |
| `0`  | Success / no blocking bugs                      |
| `1`  | Blocking bugs found (or `diff` regressed)       |
| `2`  | Bad arguments / setup error (no API key, etc.)  |
| `3`  | Engine / runtime error. `run` also uses this when the explorer visits zero pages. |

## On-disk format

```
.monkeytest/
├── config.json                     ← written by `init`, not read by the CLI
├── plan.json                       ← latest plan (tracked, version 1)
├── sitemap.json                    ← latest crawl summary
├── runs/
│   ├── 2026-05-02T08-00-00Z.json  ← one stored run per file
│   └── 2026-05-02T13-30-00Z.json
└── shots/
    ├── page-*.png                  ← explorer screenshots
    ├── flow-*-step-*-*.png         ← per-step screenshots
    └── flow-*.webm                 ← per-flow recordings
```

`plan.json` and run JSONs both carry a `schema` field (currently `1`) so future migrations have a clear upgrade path. Files written by a newer schema will be rejected with a clear error rather than silently misread.
