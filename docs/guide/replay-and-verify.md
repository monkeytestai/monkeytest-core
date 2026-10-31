# Replay and verify

`monkeytest run` records every resolved action. `rerun` plays that recording back, and `verify` tells you whether each bug is actually gone.

Neither command calls the LLM unless you pass `--heal`.

## Trace

Each flow stores a `trace` on the run file. A trace step is one resolved action:

| Field | Meaning |
| ----- | ------- |
| `index` | `0` is the opening navigation. Planned steps start at `1`. |
| `tool` | `click`, `fill`, `goto`, `wait`, `assert_text`, `press`, or `noop`. |
| `locator` | How to find the target again: `testId`, `role`, `name`, `text`, `label`, `placeholder`, and a CSS fallback. |
| `value` | Text typed or key pressed. |
| `urlBefore` / `urlAfter` | Page URL around the action. |
| `startedAt` / `durationMs` | When it ran and how long it took. |
| `status`, `observation`, `error` | What happened, including the screenshot path when one was taken. |

Replay tries locators in stability order: test id, role + name, label, placeholder, visible text, then CSS.

Each bug stores the **prefix** of that trace through the failing step (`bug.trace`), plus the evidence already on the bug: screenshot, console errors, and failed network calls.

Runs written before traces existed still load. Their bugs have no `trace`, and `verify` reports them `blocked`.

## Fingerprints

`bug.fingerprint` is the original 16-character hash: action text, tool, and a small error code. New runs still write that same value, so a bug already stored by a host keeps matching. Hosts that only saved `fingerprint` (and dropped `fingerprintParts` or `trace`) do not need a migration.

`bug.fingerprintV2` is an extra field. It is a hash of:

| Part | What is stored |
| ---- | -------------- |
| Category | The oracle that failed: `navigation`, `interaction`, `assertion`, `network`, `page-error`, or `timeout`. |
| Location | URL template. Numeric ids, uuids, and timestamps become `:id` or `:ts`. Tracking query params are dropped. |
| Role + name | Accessible role and name of the target. CSS selectors are not part of the key. |
| Error signal | A coarse class such as `target-not-found` or `not-editable`. Numbers, ids, and timestamps are stripped. |

The parts are saved on `bug.fingerprintParts` (`version: 2`). The tool name, the raw error text, and the 0.6.1 report fields (`impact`, `page_url`, `step_index`, `flow_id`, `element`) are not inputs, so two runs that picked different tools still share one `fingerprintV2`. `flow_id` is the existing `FlowResult.flowId`.

`monkeytest diff` and `monkeytest verify` use `fingerprintV2` when both bugs have it, and `fingerprint` otherwise. Switch a stored comparison over to `fingerprintV2` when you are ready. A later major version can make that the default. Until then, `fingerprint` stays the legacy hash.

The CLI and `new Monkey()` fail a step when the page throws, the document is HTTP 404, the action returns HTTP 5xx, or the control is disabled. Pass `strictOracles: false` to opt out and keep the previous bug counts. `run.strictOracles` on a single call overrides the constructor. `runPlan` still defaults this off unless the caller passes it.

The CLI and `new Monkey()` also fail a passed or skipped step that observed a **same-origin HTTP ≥500** on a document, xhr, or fetch (`--fail-on-5xx`, the default). `--no-fail-on-5xx` or `failOn5xx: false` leaves that response on the step as evidence. Image, font, and third-party 5xx responses are not promoted. `www.example.com` and `example.com` are the same site; a different port is not. `rerun` and `verify` use the same flag, so a 500 that failed the original run still fails the replay. A direct `triage(run)` does not promote unless you pass `{ failOn5xx: true }`.

## `monkeytest rerun`

```bash
monkeytest rerun                  # latest run
monkeytest rerun 2026-05-02T10-15-00Z
monkeytest rerun --heal           # LLM only if a locator misses
```

By default this replays the stored trace exactly and writes a new run file. A step whose locator no longer matches fails with `locator_mismatch` and the rest of that flow is not attempted. A step the original run already marked `skipped` stays skipped when its locator misses, so a later failure is still replayed. A step that originally passed or failed still stops the flow.

`--heal` asks the runner LLM to re-resolve that one step from the original instruction. The step is marked `resolution: "healed"`. Healing is off unless you ask for it.

If the run has no trace, rerun falls back to executing the stored plan with the LLM and says so.

Exit codes match the rest of the CLI: `1` when a non-`minor` bug is still present, `2` for bad arguments, `3` for an engine failure.

## `monkeytest verify`

```bash
monkeytest verify                       # every bug on the latest run
monkeytest verify 2026-05-02T10-15-00Z  # one run id, or a path to the run JSON / .monkeytest dir
monkeytest verify --bug <fingerprint> --repeat 3
monkeytest verify --json
```

Each bug's trace is replayed `--repeat` times (default 1). The verdicts:

| Verdict | Meaning |
| ------- | ------- |
| `fixed` | The failing step passed on every attempt. |
| `still_broken` | The failing step failed on every attempt. |
| `flaky` | The bug fired on some attempts and not others. |
| `healed` | `--heal` re-resolved a stale locator and the bug did not recur. |
| `blocked` | The replay could not reach the failing step (missing trace, prefix failure, or a locator that no longer matches). |

A locator miss on the failing step is `blocked`, not `still_broken`: the original action never ran, so the bug was not reproduced. Pass `--heal` if you want the LLM to try a new locator; a healed path that still fails is `still_broken`.

The command prints a table. `--json` prints the same report as JSON, including `exitCode`.

| Exit code | When |
| --------- | ---- |
| `0` | No bug is `still_broken` or `flaky`. `fixed`, `healed`, and `blocked` do not fail the process. |
| `1` | At least one bug is `still_broken` or `flaky` (it fired). |
| `2` | Bad arguments, unknown fingerprint, or no run to read. |
| `3` | The engine threw (browser failed to launch, and so on). |

`blocked` stays exit `0` because the check was inconclusive. Read the table before treating a `0` as "everything is fixed".

A click that Playwright considers successful is still a failure when the page throws, the document comes back HTTP 404, the action returns HTTP 5xx, or the control is disabled. Replay checks those the same way, so `verify` can report them fixed.

## Live check

`npm test` is the contributor path: unit tests and a stub LLM against `test/fixtures/demo-app`. No API key is required, and pull requests run only that.

Maintainers run the same app with a real model from Actions → **Live e2e**. Add `OPENAI_API_KEY` (model `gpt-4o-mini`) as an Actions secret. A manual or scheduled run fails when it is missing; a push to `main` skips that leg. `GEMINI_API_KEY` and `ANTHROPIC_API_KEY` are optional legs and are skipped when unset. The workflow runs on demand, nightly, and on pushes to `main`. Pull requests keep running `npm test` only, so fork PRs never receive those secrets. The maintainer steps are in `CONTRIBUTING.md`.

## Not in this version

Traces are replayed in full; they are not minimised to the shortest prefix that still reproduces the bug. There is no exporter that writes a standalone Playwright test per bug. Both are natural follow-ups on top of the trace stored on the bug.
