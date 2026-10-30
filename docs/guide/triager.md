# Triager polish

The **triager** turns the runner's raw step failures into a deduplicated list of `BugReport`s with stable fingerprints. By default it's deterministic and rule-based — fast, free, and predictable.

For better-reading bug copy you can opt into an **LLM polish pass** that rewrites each bug's `title`, `observed`, `expected`, and `triageNotes` from the structured evidence the rule-based triager already collected.

## Why two layers?

| Layer | Role | Cost | Failure mode |
| ----- | ---- | ---- | ------------ |
| **Rule-based** (always on) | Group failures into bugs, stable fingerprints, evidence merging, severity inference. | Zero LLM calls. | None — pure data transformation. |
| **LLM polish** (opt-in) | Rewrite copy in human-readable form. Tighter titles, plain-English observed/expected, actionable triage notes. | ~120 input + ~80 output tokens per bug, with prompt caching. | Per-bug `try/catch` — a bad LLM response on bug 3 never affects bug 4. The deterministic copy is always preserved on failure. |

You always get the rule-based output. The LLM polish only **improves** copy; it never invents bugs and it never overrides severity or the fingerprint.

`new Monkey()` passes `failOn5xx: true` into `triage` / `triagePolished`, so a same-origin HTTP ≥500 becomes a failed step even if the runner left that step `passed` or `skipped`. Pass `failOn5xx: false` on `Monkey` to opt out. A direct `triage(run)` call still leaves the run unchanged unless you pass `{ failOn5xx: true }`.

## Enable it

Set `triager` on `MonkeyConfig.llm`:

```ts
import { Monkey } from '@monkeytestai/monkeytester';

const monkey = new Monkey({
  llm: {
    explorer: { provider: 'gemini',    model: 'gemini-flash-lite-latest' },
    planner:  { provider: 'anthropic', model: 'claude-sonnet-4-5' },
    runner:   { provider: 'groq',      model: 'llama-3.3-70b-versatile' },
    triager:  { provider: 'anthropic', model: 'claude-haiku-4-5' },
  },
});
```

When `triager` is set, `executeAndTriage` runs the deterministic triager first and then polishes each bug in parallel (concurrency 4) with the configured LLM.

## What the polish actually changes

For each bug, the polish prompt feeds the LLM:

- The **rule-based** title / observed / expected / triageNotes (so it can see the baseline).
- The repro steps.
- A summary of the evidence: how many screenshots, top console errors (truncated), top network failures.

It returns a strict JSON object:

```ts
{
  title:        string,   // ≤ 90 chars, "<area>: <what broke>"
  observed:     string,   // past tense, 1–2 sentences, cites the concrete error
  expected:     string,   // present tense, 1 sentence
  triageNotes:  string,   // 1–3 sentences for the engineer who picks this up
}
```

`severity`, `fingerprint`, `affectedFlow`, `reproSteps`, `evidence`, and `id` are **never touched**. The polish only edits the prose fields.

## What is not a bug

`triage()` drops failures that are the runner's, not the site's, and sets the run outcome from what remains:

| `outcome` | When |
| --------- | ---- |
| `bugs_found` | One or more confirmed site bugs. |
| `clean` | At least one journey actually ran, and `bugs.length` is 0. |
| `inconclusive` | The site was reached, but every check was skipped or failed inside the runner. |
| `could_not_test` | Nothing was tested: 0 pages, 0 flows, or the site was unreachable. |

`outcome_reason` is a short code (`automation_error`, `all_flows_skipped`, `site_unreachable`, `invalid_url`, `llm_error`, `timeout`, `blocked_by_bot_protection`, `login_required`, `not_attempted`, `nothing_tested`). `login_required` is used only when a password field or login form was seen. A flow the planner merely tagged `auth_required` is `not_attempted`.

`outcome_detail` is a deterministic sentence plus a next step. It agrees with `bugs.length`. An optional planner verdict is kept only when `alignVerdict` says it does not contradict that count. When the cause is the runner, the sentence says "Our test couldn't complete".

The signature list is `AUTOMATION_FAULT_SIGNATURES`. `isOwnAutomationBug` is the check mtaiserver can call. It includes every miss mtaiclient `confirmedBugs.js` drops, plus `Cannot type text into input`, `not an <input>`, InvalidSelector, strict mode, detached nodes, and selector timeouts. HTTP 5xx, uncaught page errors, disabled controls, and document HTTP 404 are still bugs, and their fingerprints are unchanged.

A flow whose every step was skipped has status `inconclusive`, not `passed`.

## Resilience guarantees

The polish pass is designed so you can leave it on in production without worrying:

- **Per-bug try/catch.** A schema-mismatch or transient API error on one bug only affects that bug — the deterministic copy is kept and an `engine.error` event fires with the bug id.
- **Cap on bugs polished.** Default `maxBugsToPolish: 25` to bound cost on extreme runs (you can override via `triagePolished({ maxBugsToPolish })`).
- **Bounded concurrency.** Four bugs polished in parallel; no thundering herd against your provider.
- **No data loss on total failure.** If the LLM is unreachable for the entire pass, you still get every bug, with the deterministic copy.

## Cost

Tiny per bug, and the system prompt is cached:

| Provider | Model | Input (cached) | Input (new) | Output | $ per bug |
| -------- | ----- | -------------- | ----------- | ------ | --------- |
| Anthropic | `claude-haiku-4-5` | ~120 | ~80 | ~120 | **~$0.0004** |
| OpenAI | `gpt-4o-mini` | ~120 | ~80 | ~120 | **~$0.0001** |
| Anthropic | `claude-sonnet-4-5` | ~120 | ~80 | ~120 | **~$0.005** |
| Gemini | `gemini-flash-latest` | ~120 | ~80 | ~120 | **~$0.0001** |

For a typical 5-bug run, even Sonnet costs less than 3 cents. Haiku and gpt-4o-mini are the right defaults — they're plenty smart for rewriting structured input.

## Drive it directly

If you want to drive the triager outside the `Monkey` class (e.g. you stored a `RunResult` and want to polish it later):

```ts
import { triagePolished, createLLM } from '@monkeytestai/monkeytester';

const polished = await triagePolished(rawRun, {
  llm: createLLM({ provider: 'openai', model: 'gpt-4o-mini' }),
  maxBugsToPolish: 50,
});
```

Returns a brand-new `RunResult` with polished bugs. Existing `RunResult` is unchanged.

## When to leave it off

- Tight CI cost budgets where 1 cent per run matters.
- Runs that produce hundreds of bugs (raise `maxBugsToPolish` carefully or skip).
- When you're shipping the raw `RunResult` to your own LLM for further processing — let your LLM do the wording in its own voice instead.

Next: [Cost & depth →](/guide/cost-and-depth)
