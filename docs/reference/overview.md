# Reference overview

MonkeyTest Core is consumed as a **single package** — import from `@mtai/monkeytest-core`:

| Export | Role |
| ------ | ---- |
| `Monkey` | Orchestrates explore → plan → run → triage |
| `EventBus` | Subscribe to [live events](/reference/events) |
| `explore`, `plan`, `runPlan` | Individual phases (advanced) |
| `triage` | Post-process runner output |
| `createLLM` | Low-level LLM helper |

## Main result shape

`executeAndTriage` returns:

```ts
{ siteMap, plan, run }
```

- **`siteMap`** — `startUrl`, `siteType`, `summary`, `pages[]`, `failedUrls[]`  
- **`plan`** — `flows[]` with `TestStep` actions  
- **`run`** — `flows[]` with `StepResult`, `bugs[]`, `stats`  

Types are published as `.d.ts` next to `dist/index.js`.

Next: [Monkey class](/reference/monkey) →
