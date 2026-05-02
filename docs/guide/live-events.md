# Live events

MonkeyTest Core exposes a typed **`EventBus`** so hosts (CLI, worker, HTTP service) can stream **what the AI is doing** to a UI.

```ts
import { EventBus } from '@mtai/monkeytest-core';

const bus = new EventBus();
const off = bus.on((evt) => {
  // evt.ts, evt.phase, evt.type, evt.message, evt.data?
});

await monkey.executeAndTriage(url, { events: bus, run: { ... } });
off();
```

## Phases

| Phase | Meaning |
| ----- | ------- |
| `explorer` | Crawling and summarising pages |
| `planner` | Generating flows from the site map |
| `runner` | Executing Playwright steps |
| `triager` | Collapsing failures into bug reports |

## Example event types

- `explore.page_visited` — A URL was loaded and summarised  
- `plan.complete` — Test plan ready  
- `run.flow_start` / `run.step_complete` — Execution progress  
- `engine.error` — Non-fatal failure in a phase (partial results may still exist)  

For the full list, see [EventBus & live events](/reference/events).

## SaaS integration

The official MonkeyTest product persists a rolling buffer of these events for the **live progress** screen. Your integration can do the same over SSE, WebSocket, or poll-friendly JSON.
