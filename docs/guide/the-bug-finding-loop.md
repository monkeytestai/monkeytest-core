# The bug-finding loop

Most "AI testing" tools stop at *finding* bugs. MonkeyTest Core is built around the full loop: **find → fix → verify → keep watching**.

```
                ┌─────────────────────────┐
                │   1. monkeytest run     │
                │   explore + plan + run  │
                │   → plan.json + run.json│
                └────────────┬────────────┘
                             │
                             ▼
                ┌─────────────────────────┐
                │   2. you fix the bugs   │
                └────────────┬────────────┘
                             │
                             ▼
                ┌─────────────────────────┐
                │   3. monkeytest rerun   │
                │   re-execute SAME plan  │
                │   → new run.json        │
                └────────────┬────────────┘
                             │
                             ▼
                ┌─────────────────────────┐
                │   4. monkeytest diff    │
                │   prev → latest         │
                │   new / fixed / etc.    │
                └─────────────────────────┘
```

Three building blocks make this work and they're all first-class:

1. **Stable plans** — `monkeytest run` writes `plan.json` to disk. The plan is just JSON: small enough to commit to git, deterministic enough that re-running it next week produces the same flows.
2. **Run-from-plan** — `monkeytest rerun` (and `Monkey.runFromPlan()` programmatically) skip the explorer + planner phases entirely. No LLM cost for the planning step, no plan drift between runs.
3. **Bug fingerprints** — every triaged `BugReport` has a `fingerprint` derived from action + tool + normalised error. `monkeytest diff` (and `diffRuns()`) does a set diff over those fingerprints to tell you what changed.

## A typical session

```bash
# Monday morning: fresh exploration
monkeytest run https://staging.myapp.com
# → 3 critical bugs found. Exit code 1.

# … you ship fixes …

# Monday afternoon: verify the fixes
monkeytest rerun
# → 1 critical bug still failing. Exit code 1.

# Compare to know exactly what moved
monkeytest diff prev latest
#   2 fixed, 1 still broken, 0 new, 0 regressed (net -2)
```

## Why "rerun the same plan" matters

LLMs are stochastic. Even with the same site, two `monkeytest run` invocations will usually produce *slightly* different plans — one might prioritise a checkout flow, the next might focus on search. That's fine for discovery, but it's terrible for verifying a fix:

- Did flow X actually pass this time, or did the planner just not write flow X?
- Is bug Y really gone, or is it now hiding in a flow we didn't generate?

Re-running the **stored plan** removes that ambiguity. Same flows, same steps, same expectations — only the application under test has changed.

## Programmatic API

The CLI is a thin wrapper around two engine methods.

```ts
import { Monkey, autoLLMConfig, savePlan, loadPlan, saveRun, loadRun, diffRuns } from '@mtai/monkeytest-core';

const monkey = new Monkey({ llm: autoLLMConfig({ quality: 'balanced' }) });

// Day 1 — discover
const { plan, run: firstRun } = await monkey.executeAndTriage('https://example.com', {
  run: { screenshotsDir: '.monkeytest/shots' },
});
savePlan(plan, { dir: '.monkeytest', label: 'main-suite' });
saveRun(firstRun, { dir: '.monkeytest' });

// Day 2 — verify after fixing some bugs
const stored = loadPlan('.monkeytest');
const { run: secondRun } = await monkey.runFromPlan(stored.plan, {
  run: { screenshotsDir: '.monkeytest/shots' },
});
saveRun(secondRun, { dir: '.monkeytest' });

// What changed?
const diff = diffRuns(firstRun, secondRun);
console.log(`${diff.stats.fixed} fixed, ${diff.stats.regressed} regressed`);
```

## CI integration

The exit-code contract makes this easy to wire into a pipeline:

| Command           | Exit 0 if…                                          | Exit 1 if…                                            |
| ----------------- | --------------------------------------------------- | ----------------------------------------------------- |
| `monkeytest run`  | No blocking bugs (severity != `minor`)              | Any major / critical bug found                        |
| `monkeytest rerun`| No blocking bugs                                    | Any major / critical bug still failing                |
| `monkeytest diff` | No new bugs and nothing regressed                   | New bugs OR severity escalated (`minor → major`)      |

Pattern that works in any CI:

```bash
# Check in the plan once. Subsequent CI runs verify against it.
if [ -f .monkeytest/plan.json ]; then
  monkeytest rerun --quality cheap
else
  monkeytest run "$DEPLOY_URL" --quality cheap
fi
```

## SaaS variant: the rerun button

Everything above also exists in the [MonkeyTest SaaS](https://monkeytest.ai). On any completed report:

- **"Re-run same plan"** queues a job that calls `Monkey.runFromPlan()` against the stored `test_plan` of that audit. New audit row, lineage tracked via `parent_audit_id`.
- **"vs previous run"** card shows the same `new / fixed / persisting / regressed` counts the CLI prints, with a click-through to bugs by status.
- **"Run history"** timeline lets you walk back through every re-run of the original.

The library is the source of truth — the SaaS is just a hosted runner with a UI on top of the same engine you can pip-install for free.

## What it isn't

- **Not a recorder.** No "click here, type there" capture step. The plan is generated from the LLM's understanding of the site.
- **Not regression-only.** The first `run` is real exploration; reruns are deterministic. Both are first-class.
- **Not a full Selenium replacement.** If you need pixel-perfect deterministic suites for a checkout flow, write Playwright. MonkeyTest covers everything *around* that.
