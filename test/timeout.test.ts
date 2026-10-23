import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFlowTimeout } from '../src/runner/timeout.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('createFlowTimeout', () => {
  it('rejects and runs the abort hook when the budget is exceeded', async () => {
    vi.useFakeTimers();
    let fired = 0;
    const guard = createFlowTimeout('checkout', 1_000, () => { fired += 1; });
    const assertion = expect(guard.promise).rejects.toThrow('flow "checkout" exceeded 1000ms');
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(fired).toBe(1);
    expect(() => guard.cancel()).not.toThrow();
  });

  it('clears the timer so a finished flow cannot reject or abort later', async () => {
    vi.useFakeTimers();
    let fired = 0;
    let rejected = false;
    const guard = createFlowTimeout('checkout', 1_000, () => { fired += 1; });
    void guard.promise.then(
      () => {},
      () => { rejected = true; },
    );
    guard.cancel();
    guard.cancel();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fired).toBe(0);
    expect(rejected).toBe(false);
  });
});
