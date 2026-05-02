# Live events

Every phase of the engine emits typed events through an optional `EventBus`. This is the same channel that powers MonkeyTest Cloud's live-activity panel — you can plug it into your own UI in five lines.

```ts
import { Monkey, EventBus, autoLLMConfig } from '@mtai/monkeytest-core';

const bus = new EventBus();
const off = bus.on(evt => {
  console.log(`[${evt.phase}] ${evt.type}: ${evt.message}`);
});

await new Monkey({ llm: autoLLMConfig() }).executeAndTriage(url, {
  events: bus,
  explore: { maxPages: 8, screenshotsDir: '.monkeytest/shots' },
  plan:    { maxFlows: 4 },
  run:     { screenshotsDir: '.monkeytest/shots' },
});

off();
```

## Event shape

```ts
interface LiveEvent {
  ts: string;             // ISO timestamp
  phase: 'explorer' | 'planner' | 'runner' | 'triager';
  type:  LiveEventType;   // see below
  message: string;        // one-line, human readable
  data?: Record<string, unknown>;  // structured payload
}
```

## Phases

| Phase | What's happening |
| ----- | ---------------- |
| `explorer` | Crawling and summarising pages |
| `planner`  | Generating flows from the site map |
| `runner`   | Executing Playwright steps |
| `triager`  | Collapsing failures into bug reports |

## Common event types

| Type | Phase | Notes |
| ---- | ----- | ----- |
| `explore.start` | explorer | First event of the run. `data.url` is the start URL. |
| `explore.page_visited` | explorer | Per-page success. `data.url`, `data.title`. |
| `explore.page_failed` | explorer | Per-page failure. `data.url`, `data.reason`. |
| `explore.screenshot` | explorer | A page screenshot was written. `data.path`. |
| `explore.complete` | explorer | Site map ready. `data.pages`, `data.failed`. |
| `plan.start` | planner | Asking the LLM for a plan. |
| `plan.complete` | planner | Plan ready. `data.flows`. |
| `plan.skipped` | planner | No flows produced. `data.reason`. |
| `run.start` | runner | Executing the plan. `data.flows`. |
| `run.flow_start` | runner | A flow began. `data.flowId`, `data.name`, `data.flowIndex`, `data.flowsTotal`. |
| `run.step_start` | runner | A step began. `data.flowId`, `data.index`, `data.step`. |
| `run.step_complete` | runner | A step finished. `data.status`, `data.observation`, `data.screenshotPath`. |
| `run.screenshot` | runner | A step screenshot was written. `data.path`, `data.flowId`, `data.index`. |
| `run.flow_complete` | runner | A flow finished. `data.status`, `data.bugs`. |
| `run.complete` | runner | All flows finished. `data.stats`. |
| `triage.start` / `triage.complete` | triager | Collapsing failures into bugs. |
| `engine.error` | any | Non-fatal failure in a phase. `data.error`. Partial results may still exist. |

The exhaustive type-level list lives at [Reference: EventBus](/reference/events).

## Patterns

### Forward to SSE

```ts
import express from 'express';
const app = express();
app.get('/runs/:id/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const off = bus.on(evt => res.write(`data: ${JSON.stringify(evt)}\n\n`));
  req.on('close', off);
});
```

### Buffer + persist (poll-friendly)

A common server-side pattern: keep a rolling 200-event buffer in memory, throttle DB writes to every 750ms, and serve the latest snapshot via a regular HTTP GET. This is exactly what MonkeyTest Cloud does — the engine doesn't ship a buffer/storage layer because every host wants something slightly different.

### Filter by phase

```ts
bus.on(evt => {
  if (evt.phase === 'runner' && evt.type === 'run.screenshot') {
    refreshLiveShot(evt.data.path);
  }
});
```

## Performance notes

- The `EventBus` is in-process and synchronous; listeners run on the same event loop as the engine.
- Keep listeners cheap — a slow listener will slow down the run.
- For UI use, prefer **buffering** in your host process and shipping batches to the browser instead of one event per render.
