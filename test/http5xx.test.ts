import { describe, expect, it } from 'vitest';
import { triage } from '../src/triager/index.js';
import { findSameOriginServerError } from '../src/runner/http5xx.js';
import type { NetworkFailureEvidence, RunResult, StepResult } from '../src/types.js';

const ORIGIN = 'https://www.bananabeings.com';

describe('same-origin HTTP 5xx promotion', () => {
  it('turns a passed step with a same-origin 500 into one critical bug', () => {
    const run = passedRun(step({
      status: 'passed',
      networkFailures: [failure('POST', `${ORIGIN}/api/contact`, 500, 'document')],
    }));

    const untouched = triage(run);
    expect(untouched.bugs).toHaveLength(0);
    expect(untouched.flows[0].status).toBe('passed');
    expect(untouched.flows[0].steps[0].status).toBe('passed');

    const triaged = triage(run, { failOn5xx: true });
    expect(triaged.bugs).toHaveLength(1);
    expect(triaged.bugs[0].severity).toBe('critical');
    expect(triaged.bugs[0].fingerprintParts).toMatchObject({
      category: 'network',
      errorSignal: 'http-5xx',
    });
    expect(triaged.bugs[0].evidence.networkFailures[0].status).toBe(500);
    expect(triaged.flows[0].status).toBe('failed');
    expect(triaged.flows[0].steps[0].status).toBe('failed');
    expect(triaged.flows[0].steps[0].error).toBe('http-500');
    expect(triaged.flows[0].trace?.steps[0].status).toBe('failed');
    expect(triaged.stats.bugsCritical).toBe(1);
    expect(triaged.stats.flowsFailed).toBe(1);
    expect(triaged.stats.stepsFailed).toBe(1);

    const again = triage(run, { failOn5xx: true });
    expect(again.bugs[0].fingerprint).toBe(triaged.bugs[0].fingerprint);
    expect(again.bugs[0].fingerprintV2).toBe(triaged.bugs[0].fingerprintV2);
  });

  it('promotes a skipped step and ignores third-party, asset, and other-port failures', () => {
    const skipped = triage(passedRun(step({
      status: 'skipped',
      observation: 'Click on Send message could not be completed by the agent.',
      networkFailures: [failure('POST', `${ORIGIN}/api/contact`, 500, 'fetch')],
    })), { failOn5xx: true });
    expect(skipped.bugs).toHaveLength(1);
    expect(skipped.flows[0].steps[0].error).toBe('http-500');

    const noise: NetworkFailureEvidence[] = [
      failure('GET', 'https://cdn.example/app.js', 500, 'script'),
      failure('POST', 'https://analytics.example/collect', 500, 'fetch'),
      failure('GET', `${ORIGIN}/hero.png`, 500, 'image'),
      failure('POST', 'https://www.bananabeings.com:8443/api/contact', 500, 'fetch'),
      failure('GET', 'https://shop.example/missing', 404, 'document'),
    ];
    expect(findSameOriginServerError(noise, [ORIGIN])).toBeUndefined();
    const quiet = triage(passedRun(step({ status: 'passed', networkFailures: noise })), { failOn5xx: true });
    expect(quiet.bugs).toHaveLength(0);
    expect(quiet.flows[0].steps[0].status).toBe('passed');
  });

  it('treats the www host and the apex host as the same site', () => {
    const run = passedRun(step({
      status: 'passed',
      networkFailures: [failure('POST', 'https://bananabeings.com/api/contact', 500, 'xhr')],
    }), 'https://www.bananabeings.com/help');
    const triaged = triage(run, { failOn5xx: true });
    expect(triaged.bugs).toHaveLength(1);
    expect(triaged.bugs[0].severity).not.toBe('minor');
  });
});

function failure(method: string, url: string, status: number, resourceType: string): NetworkFailureEvidence {
  return { method, url, status, resourceType };
}

function step(partial: Pick<StepResult, 'status' | 'networkFailures'> & { observation?: string }): StepResult {
  return {
    index: 1,
    action: 'Submit the contact form',
    expectation: 'The form submits without a server error.',
    status: partial.status,
    observation: partial.observation ?? 'Clicked Send message.',
    tool: 'click',
    target: 'button:Send message',
    networkFailures: partial.networkFailures,
  };
}

function passedRun(recorded: StepResult, startUrl = `${ORIGIN}/help`): RunResult {
  return {
    startUrl: ORIGIN,
    startedAt: '2026-10-24T00:00:00.000Z',
    finishedAt: '2026-10-24T00:00:01.000Z',
    bugs: [],
    stats: {
      flowsTotal: 1,
      flowsPassed: 1,
      flowsFailed: 0,
      flowsBlocked: 0,
      stepsTotal: 1,
      stepsPassed: recorded.status === 'passed' ? 1 : 0,
      stepsFailed: 0,
      bugsCritical: 0,
      bugsMajor: 0,
      bugsMinor: 0,
    },
    flows: [{
      flowId: 'contact',
      name: 'Contact',
      description: 'Submit the help form.',
      kind: 'happy_path',
      startUrl,
      status: 'passed',
      steps: [recorded],
      durationMs: 100,
      bugIds: [],
      trace: {
        version: 1,
        flowId: 'contact',
        name: 'Contact',
        startUrl,
        steps: [{
          index: recorded.index,
          action: recorded.action,
          tool: 'click',
          status: recorded.status,
          observation: recorded.observation,
          networkFailures: recorded.networkFailures,
        }],
      },
    }],
  };
}
