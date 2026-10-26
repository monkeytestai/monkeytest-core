/**
 * Live event bus for the MonkeyTest engine.
 *
 * Every phase (explorer, planner, runner, triager) emits structured `LiveEvent`s
 * here so a SaaS frontend can show a near-realtime activity feed:
 *
 *   - "Exploring https://example.com/pricing"
 *   - "Captured screenshot page-2-example-com.png"
 *   - "Planner generated 3 flows"
 *   - "Flow 1/3: Browse pricing → Step 2: Click 'Sign up'"
 *
 * The bus is a tiny strongly-typed wrapper around Node's `EventEmitter`. We
 * deliberately do not use a streaming/SSE format here — that's a transport
 * concern. The engine just emits events; the host (server or CLI) decides
 * whether to persist them, broadcast them over WebSocket, or drop them.
 *
 * Event shape:
 *   {
 *     ts:      ISO timestamp,
 *     phase:   'explorer' | 'planner' | 'runner' | 'triager',
 *     type:    machine-readable event id (stable, snake_case),
 *     message: short human-readable line for the UI,
 *     data?:   optional structured payload
 *   }
 *
 * All events are best-effort. Listeners that throw are caught and logged so a
 * misbehaving consumer can never break a test run.
 */

import { EventEmitter } from 'node:events';

export type LivePhase = 'explorer' | 'planner' | 'runner' | 'triager';

export interface LiveEvent {
  /** ISO-8601 timestamp the event was created. */
  ts: string;
  /** Which engine phase produced the event. */
  phase: LivePhase;
  /** Stable machine-readable id (snake_case). Use the `LiveEventType` union. */
  type: LiveEventType;
  /** Short, human-readable line. Already i18n-ready and safe to render verbatim. */
  message: string;
  /** Optional structured payload. Shape depends on `type`. */
  data?: Record<string, unknown>;
}

export type LiveEventType =
  // explorer
  | 'explore.start'
  | 'explore.page_visited'
  | 'explore.page_failed'
  | 'explore.screenshot'
  | 'explore.warning'
  | 'explore.complete'
  // planner
  | 'plan.start'
  | 'plan.complete'
  | 'plan.skipped'
  // runner
  | 'run.start'
  | 'run.flow_start'
  | 'run.step_start'
  | 'run.step_complete'
  | 'run.flow_complete'
  | 'run.screenshot'
  | 'run.complete'
  // triager
  | 'triage.start'
  | 'triage.bug_found'
  | 'triage.complete'
  // generic
  | 'engine.error';

export type LiveEventListener = (event: LiveEvent) => void;

/**
 * Strongly-typed pub/sub the engine uses to publish lifecycle events.
 *
 * Pass a single `EventBus` to `Monkey.executeAndTriage` (via `events`) and
 * subscribe with `on()` to capture everything that happens.
 */
export class EventBus {

  private readonly emitter = new EventEmitter();

  constructor(){
    // Keep the listener cap generous — the SaaS server, CLI logger, and a
    // dev tap can all subscribe to the same bus without warnings.
    this.emitter.setMaxListeners(50);
  }

  /** Subscribe to every event. Returns an unsubscribe function. */
  on(listener: LiveEventListener): () => void {
    const wrapped = (e: LiveEvent) => {
      try { listener(e); }
      catch (err) {
        // Don't let a buggy listener crash the engine.
        // eslint-disable-next-line no-console
        console.error('[monkeytester] live event listener threw:', err);
      }
    };
    this.emitter.on('event', wrapped);
    return () => this.emitter.off('event', wrapped);
  }

  /**
   * Emit an event. Phase + type + message are required; `data` is optional
   * structured context. The bus stamps the timestamp.
   */
  emit(event: Omit<LiveEvent, 'ts'>): void {
    const full: LiveEvent = { ts: new Date().toISOString(), ...event };
    this.emitter.emit('event', full);
  }

}

/**
 * Convenience: a no-op bus used internally when the caller did not pass one.
 * Lets phase code call `bus.emit(...)` unconditionally without null checks.
 */
export function noopBus(): EventBus {
  const bus = new EventBus();
  // Override `emit` to drop everything; no listeners get attached.
  (bus as { emit: (e: unknown) => void }).emit = () => undefined;
  return bus;
}
