/**
 * Stable bug fingerprints (v2).
 *
 * The hash is sha1 of five fields, never the LLM's tool choice and never
 * raw error prose:
 *
 *   category | location | role | name | errorSignal
 *
 *   category    — which oracle failed (navigation, interaction, assertion, …)
 *   location    — URL template; ids, uuids, and timestamps replaced
 *   role, name  — accessible role + name of the target element
 *   errorSignal — coarse error class; numbers, ids, and timestamps stripped
 *
 * `BugReport.fingerprint` stays the legacy v1 hash (action text + tool + a
 * small error code), byte-for-byte with older engines, so a stored bug still
 * matches after upgrade. The stable hash is the additive `fingerprintV2`.
 * `diffRuns` uses v2 only when both runs carry it, and uses v1 otherwise.
 */

import { createHash } from 'node:crypto';
import type { FingerprintParts, TraceLocator } from '../types.js';

export const FINGERPRINT_VERSION = 2 as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_ID_RE = /^[0-9a-f]{16,}$/i;
const DROP_QUERY = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'mc_cid', 'mc_eid', '_', 't', 'ts', 'timestamp',
  'nocache', 'cachebust', 'cache_bust',
]);

/** Coarse failure class. Volatile digits, ids, and timestamps are removed. */
export function normaliseErrorSignal(error: string | undefined): string {
  const raw = (error || '').toLowerCase();
  if (!raw.trim()) return 'no-error';

  if (raw.includes('strict mode violation')) return 'ambiguous-target';
  if (
    raw.includes('intercepts pointer')
    || raw.includes('not visible')
    || raw.includes('hidden')
    || raw.includes('outside of the viewport')
  ) return 'element-not-actionable';
  if (raw.includes('not attached') || raw.includes('detached')) return 'element-detached';
  if (
    raw.includes('not an <input')
    || raw.includes('not editable')
    || raw.includes('element is not')
    || raw.includes('contenteditable')
  ) return 'not-editable';
  if (raw.includes('invalid_url') || raw.includes('non-http')) return 'invalid-url';
  if (raw.includes('locator_mismatch') || raw.includes('no longer matches')) return 'locator-mismatch';
  // Product oracles. These codes are checked before the broad "navigation"
  // substring and the 5xx regex so `http-404` stays a 404 and `pageerror`
  // stays a page error. The exception text itself is not the signal.
  if (raw.includes('pageerror') || raw.includes('page error')) return 'page-error';
  if (
    raw.includes('element-disabled')
    || raw.includes('control is disabled')
    || raw.includes('element is disabled')
  ) return 'element-disabled';
  if (raw.includes('http-404') || raw.includes('http 404')) return 'http-4xx';
  if (
    raw.includes('net::err_')
    || raw.includes('err_connection')
    || raw.includes('err_name')
    || raw.includes('err_aborted')
    || raw.includes('err_address')
    || raw.includes('navigation')
  ) return 'navigation-failed';
  if (raw.includes('assertion') || raw.includes('tohave') || raw.includes('expected text')) return 'assertion-failed';
  if (/\b5\d\d\b/.test(raw) || raw.includes('server error') || raw.includes('internal server error')) return 'http-5xx';
  if (
    (raw.includes('timeout') || raw.includes('waiting for'))
    && (raw.includes('locator') || raw.includes('selector') || raw.includes('getby'))
  ) return 'target-not-found';
  if (raw.includes('timeout')) return 'timeout';
  if (
    raw.includes('not found')
    || raw.includes('no element')
    || raw.includes('no node')
    || raw.includes('resolved to 0')
  ) return 'target-not-found';

  return stripVolatile(raw).slice(0, 80) || 'unknown';
}

/**
 * Lowercase, collapse whitespace, and replace tokens that change between
 * runs (uuids, long ids, timestamps). Short numbers stay — "page 2" is a
 * real label, "order 18482931" is not.
 */
export function normaliseLabel(raw: string | undefined): string {
  if (!raw) return '';
  return stripVolatile(raw, { keepShortNumbers: true }).slice(0, 80);
}

/** Turn a concrete URL into a page key. Query order is normalised. */
export function normaliseLocation(raw: string | undefined): string {
  if (!raw) return '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return stripVolatile(raw).slice(0, 160);
  }

  const path = url.pathname
    .split('/')
    .map(seg => templateSegment(safeDecode(seg)))
    .join('/') || '/';

  const params = [...url.searchParams.entries()]
    .filter(([key]) => !DROP_QUERY.has(key.toLowerCase()))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key.toLowerCase()}=${templateSegment(value) || ':v'}`);

  const search = params.length ? `?${params.join('&')}` : '';
  return `${url.origin}${path}${search}`;
}

export function failureCategory(input: {
  tool?: string;
  error?: string;
  observation?: string;
  networkStatus?: number;
  errorSignal?: string;
}): string {
  const signal = input.errorSignal ?? normaliseErrorSignal(input.error || input.observation);
  const blob = `${input.error || ''} ${input.observation || ''}`.toLowerCase();

  if (input.tool === 'assert_text' || signal === 'assertion-failed') return 'assertion';
  if (signal === 'page-error' || blob.includes('page crash') || blob.includes('pageerror')) return 'page-error';
  if (signal === 'http-5xx' || (input.networkStatus !== undefined && input.networkStatus >= 500)) return 'network';
  if (
    signal === 'http-4xx'
    || input.tool === 'goto'
    || signal === 'navigation-failed'
    || signal === 'invalid-url'
  ) return 'navigation';
  if (signal === 'element-disabled') return 'interaction';
  if (signal === 'timeout') return 'timeout';
  return 'interaction';
}

export function targetIdentity(
  locator: TraceLocator | undefined,
  target: string | undefined,
  tool: string | undefined,
): { role: string; name: string } {
  if (tool === 'goto' || tool === 'noop') return { role: '', name: '' };
  if (tool === 'assert_text') {
    return { role: 'text', name: normaliseLabel(target || locator?.target || locator?.text || '') };
  }

  const role = (locator?.role || '').toLowerCase();
  const name = normaliseLabel(
    locator?.name || locator?.label || locator?.placeholder || locator?.text || '',
  );
  if (role || name) return { role, name };

  const parsed = (target || '').match(/^([a-z]+)\s*:\s*(.+)$/i);
  if (parsed) {
    return { role: parsed[1].toLowerCase(), name: normaliseLabel(parsed[2]) };
  }
  return { role: '', name: '' };
}

export function failureLocation(input: {
  tool?: string;
  locatorTarget?: string;
  urlBefore?: string;
  urlAfter?: string;
  fallback?: string;
}): string {
  const pick = (value: string | undefined): string | undefined => {
    if (!value) return undefined;
    if (value.startsWith('about:')) return undefined;
    return value;
  };

  if (input.tool === 'goto') {
    return pick(input.locatorTarget) || pick(input.urlAfter) || pick(input.fallback) || '';
  }
  return pick(input.urlBefore) || pick(input.urlAfter) || pick(input.fallback) || '';
}

export interface FingerprintInput {
  /** Step instruction. Required for a byte-identical v1 `fingerprint`. */
  action?: string;
  tool?: string;
  error?: string;
  observation?: string;
  location?: string;
  locator?: TraceLocator;
  /** Legacy `StepResult.target` (`button:Sign in`, a CSS selector, …). */
  target?: string;
  networkStatus?: number;
}

export function fingerprintFromParts(parts: FingerprintParts): string {
  const material = [
    'v2',
    parts.category,
    parts.location,
    parts.role,
    parts.name,
    parts.errorSignal,
  ].join('|');
  return createHash('sha1').update(material).digest('hex').slice(0, 16);
}

/**
 * Legacy v1 hash. This is the algorithm shipped before stable fingerprints:
 * sha1 of `action | tool | errorCode`, first 16 hex chars. Do not change it.
 * Stored bugs only have this string, so they cannot be re-hashed.
 */
export function legacyFingerprint(step: { action: string; tool?: string; error?: string }): string {
  return createHash('sha1')
    .update([
      step.action.trim().toLowerCase(),
      step.tool || 'unknown',
      legacyErrorCode(step.error),
    ].join('|'))
    .digest('hex')
    .slice(0, 16);
}

/** Build both hashes. `fingerprint` is v1; `fingerprintV2` ignores the tool name. */
export function fingerprintFailure(input: FingerprintInput): {
  fingerprint: string;
  fingerprintV2: string;
  parts: FingerprintParts;
} {
  const errorSignal = normaliseErrorSignal(input.error || input.observation);
  const category = failureCategory({ ...input, errorSignal });
  const identity = targetIdentity(input.locator, input.target, input.tool);
  const parts: FingerprintParts = {
    version: FINGERPRINT_VERSION,
    category,
    location: normaliseLocation(input.location),
    role: identity.role,
    name: identity.name,
    errorSignal,
  };
  return {
    fingerprint: legacyFingerprint({
      action: input.action || '',
      tool: input.tool,
      error: input.error,
    }),
    fingerprintV2: fingerprintFromParts(parts),
    parts,
  };
}

/** The v1 error code. Order and wording match the historical triager. */
function legacyErrorCode(error: string | undefined): string {
  const err = (error || '').toLowerCase();
  if (!err) return 'no-error';
  if (err.includes('timeout')) return 'timeout';
  if (err.includes('not found') || err.includes('no element')) return 'selector-missing';
  if (err.includes('not visible') || err.includes('hidden')) return 'element-hidden';
  if (err.includes('navigation')) return 'navigation-failed';
  if (err.includes('assertion_failed')) return 'assertion-failed';
  if (err.includes('invalid_url')) return 'invalid-url';
  return err.replace(/\s+/g, '-').slice(0, 40);
}

/* ── internals ────────────────────────────────────────────────────────── */

function templateSegment(seg: string): string {
  if (!seg) return seg;
  if (UUID_RE.test(seg) || HEX_ID_RE.test(seg)) return ':id';
  if (/^\d{10,13}$/.test(seg)) return ':ts';
  if (/^\d+$/.test(seg)) return ':id';
  if (/\d{4}-\d{2}-\d{2}/.test(seg)) return ':ts';
  return seg.toLowerCase();
}

function safeDecode(seg: string): string {
  try { return decodeURIComponent(seg); }
  catch { return seg; }
}

function stripVolatile(raw: string, opts: { keepShortNumbers?: boolean } = {}): string {
  let s = raw
    .toLowerCase()
    .replace(/\u00a0/g, ' ')
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<id>')
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?z?)?\b/gi, '<ts>')
    .replace(/\b\d{10,13}\b/g, '<ts>');

  if (opts.keepShortNumbers) {
    s = s.replace(/\b\d{5,}\b/g, '<id>');
  } else {
    s = s.replace(/\b\d+\b/g, '<n>');
  }

  return s.replace(/\s+/g, ' ').trim();
}
