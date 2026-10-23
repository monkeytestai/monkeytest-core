/**
 * Wall-clock guard for a single flow.
 *
 * The previous guard was a bare `setTimeout` inside `Promise.race`. When the
 * flow finished first the timer kept running (and could reject with nobody
 * listening). When the timer won, the Playwright context was left open until
 * the whole browser closed. `cancel()` clears the timer, and `onFire` is how
 * the runner aborts the context the moment the budget is exceeded.
 */

export interface FlowTimeout {
  promise: Promise<void>;
  /** Stop the timer. Safe to call more than once, including after it fired. */
  cancel: () => void;
}

export function createFlowTimeout(
  flowName: string,
  timeoutMs: number,
  onFire?: () => void,
): FlowTimeout {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settle: (() => void) | undefined;

  const promise = new Promise<void>((resolve, reject) => {
    settle = resolve;
    timer = setTimeout(() => {
      timer = undefined;
      try { onFire?.(); }
      catch { /* closing the context must not mask the timeout */ }
      reject(new Error(`flow "${flowName}" exceeded ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return {
    promise,
    cancel() {
      if (timer !== undefined){
        clearTimeout(timer);
        timer = undefined;
      }
      // Settle so a cancelled guard cannot reject later and is not left pending.
      const resolve = settle;
      settle = undefined;
      resolve?.();
    },
  };
}
