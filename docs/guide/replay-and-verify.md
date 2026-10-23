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

New bugs are keyed by four things. The hash does **not** include the LLM's tool choice or the raw error string.

| Part | What is stored |
| ---- | -------------- |
| Category | The oracle that failed: `navigation`, `interaction`, `assertion`, `network`, `page-error`, or `timeout`. |
| Location | URL template. Numeric ids, uuids, and timestamps become `:id` or `:ts`. Tracking query params are dropped. |
| Role + name | Accessible role and name of the target. CSS selectors are not part of the key. |
| Error signal | A coarse class such as `target-not-found` or `not-editable`. Numbers, ids, and timestamps are stripped. |

The parts are saved on `bug.fingerprintParts` (`version: 2`). `monkeytest diff` recomputes the hash from those parts. Older bugs keep the fingerprint string they were saved with, so two historical runs still diff against each other.

## `monkeytest rerun`

```bash
monkeytest rerun                  # latest run
monkeytest rerun 2026-05-02T10-15-00Z
monkeytest rerun --heal           # LLM only if a locator misses
```

By default this replays the stored trace exactly and writes a new run file. A step whose locator no longer matches fails with `locator_mismatch` and the rest of that flow is not attempted.

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

## Not in this version

Traces are replayed in full; they are not minimised to the shortest prefix that still reproduces the bug. There is no exporter that writes a standalone Playwright test per bug. Both are natural follow-ups on top of the trace stored on the bug.
