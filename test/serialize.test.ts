import { describe, expect, it } from 'vitest';
import { bugTracePrefix, serializeTrace, serializeTraceStep } from '../src/trace/serialize.js';
import type { FlowTrace, TraceStep } from '../src/types.js';

describe('serializeTrace', () => {
  it('drops empty fields, rounds duration, and writes locator keys in a stable order', () => {
    const step: TraceStep = {
      index: 1,
      tool: 'fill',
      status: 'failed',
      action: 'Type an email',
      expectation: '',
      value: 'ada@example.com',
      urlBefore: 'http://127.0.0.1:9/',
      urlAfter: undefined,
      startedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 12.6,
      observation: 'Fill failed',
      error: 'not editable',
      resolution: 'recorded',
      locator: {
        strategy: 'role',
        target: 'textbox:Email',
        css: '[data-testid="email"]',
        testId: 'email',
        name: 'Email',
        role: 'textbox',
        text: '',
        label: undefined,
      },
    };

    const serialized = serializeTraceStep(step);
    expect(serialized.durationMs).toBe(13);
    expect(serialized).not.toHaveProperty('expectation');
    expect(serialized).not.toHaveProperty('urlAfter');
    expect(Object.keys(serialized.locator!)).toEqual([
      'strategy', 'target', 'role', 'name', 'testId', 'css',
    ]);

    const trace = serializeTrace(traceOf([step, { index: 2, tool: 'noop', status: 'skipped', action: 'Later' }]));
    const again = JSON.parse(JSON.stringify(trace)) as FlowTrace;
    expect(again).toEqual(trace);
    expect(again.version).toBe(1);
    expect(bugTracePrefix(trace, 1).steps.map(item => item.index)).toEqual([1]);
  });
});

function traceOf(steps: TraceStep[]): FlowTrace {
  return {
    version: 1,
    flowId: 'checkout',
    name: 'Checkout',
    startUrl: 'http://127.0.0.1:9/',
    description: '',
    steps,
  };
}
