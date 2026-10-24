# EventBus & live events

```ts
import { EventBus, type LiveEvent } from '@monkeytestai/monkeytest-core';

const events = new EventBus();
events.on((e: LiveEvent) => {
  console.log(e.type, e.message, e.data);
});
```

## `LiveEvent` shape

| Field | Type | Description |
| ----- | ---- | ----------- |
| `ts` | `string` | ISO-8601 timestamp |
| `phase` | `'explorer' \| 'planner' \| 'runner' \| 'triager'` | Pipeline phase |
| `type` | `string` | Stable machine id (e.g. `run.step_complete`) |
| `message` | `string` | Human-readable one-liner |
| `data` | `object?` | Structured payload (URLs, screenshot basenames, etc.) |

## Common `type` values

**Explorer:** `explore.start`, `explore.page_visited`, `explore.page_failed`, `explore.screenshot`, `explore.complete`

**Planner:** `plan.start`, `plan.complete`, `plan.skipped`

**Runner:** `run.start`, `run.flow_start`, `run.step_start`, `run.step_complete`, `run.flow_complete`, `run.complete`, `run.screenshot`

**Triager:** `triage.start`, `triage.complete`

**Errors:** `engine.error`

Listeners must not throw — errors are caught internally so a bad logger cannot abort a run.
