import { describe, expect, it } from 'vitest';
import { oracleFromEvidence } from '../src/runner/evidence.js';
import { failureCategory, normaliseErrorSignal } from '../src/trace/fingerprint.js';
import type { NetworkFailureEvidence } from '../src/types.js';

describe('product oracles', () => {
  it('maps the seeded failure codes onto stable signals and categories', () => {
    expect(normaliseErrorSignal('pageerror')).toBe('page-error');
    expect(normaliseErrorSignal('http-404')).toBe('http-4xx');
    expect(normaliseErrorSignal('http-500')).toBe('http-5xx');
    expect(normaliseErrorSignal('element-disabled')).toBe('element-disabled');

    expect(failureCategory({ tool: 'click', error: 'pageerror' })).toBe('page-error');
    expect(failureCategory({ tool: 'click', error: 'http-404' })).toBe('navigation');
    expect(failureCategory({ tool: 'click', error: 'http-500' })).toBe('network');
    expect(failureCategory({ tool: 'click', error: 'element-disabled' })).toBe('interaction');
  });

  it('prefers a page error over HTTP failures and ignores non-action responses', () => {
    const document500: NetworkFailureEvidence = {
      url: 'http://127.0.0.1/api/contact', method: 'POST', status: 500, resourceType: 'document',
    };
    const document404: NetworkFailureEvidence = {
      url: 'http://127.0.0.1/missing', method: 'GET', status: 404, resourceType: 'document',
    };
    expect(oracleFromEvidence(['save failed'], [document500])?.error).toBe('pageerror');
    expect(oracleFromEvidence([], [document404, document500])?.error).toBe('http-500');
    expect(oracleFromEvidence([], [document404])?.error).toBe('http-404');
    expect(oracleFromEvidence([], [
      { url: 'http://127.0.0.1/favicon.ico', method: 'GET', status: 404, resourceType: 'image' },
      { url: 'http://127.0.0.1/hero.png', method: 'GET', status: 500, resourceType: 'image' },
    ])).toBeNull();
  });
});
