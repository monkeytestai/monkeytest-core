/**
 * Coerce the shapes models actually return into the types our phases store.
 *
 * Structured-output calls still validate with Zod. These helpers run first so
 * a clear mismatch (a login surface sent as `{url, label}`, a boolean sent as
 * `"false"`, one object where an array was requested) becomes the internal
 * value instead of failing the whole audit. Unreadable values stay unreadable
 * and the caller decides whether to fall back.
 *
 * Call sites that validate model JSON:
 *   - explorer.summariseSite  — site type, journeys, auth surfaces
 *   - explorer.summarisePage  — per-page summary, auth flag, interactive list
 *   - planner.generate        — loose object; salvage coerces each flow
 *   - triager.polish          — bug title / observed / expected / notes
 *   - runner.resolveAction    — one Playwright tool call (also used when healing)
 * Forms, fault flows, and verify verdicts do not call a model.
 */

const PROSE_KEYS = ['summary', 'text', 'description', 'content', 'name', 'title', 'label', 'value'] as const;
const LABEL_KEYS = ['label', 'name', 'title', 'text', 'value'] as const;
const LOCATION_KEYS = ['url', 'href', 'path'] as const;
const ENVELOPE_KEYS = ['data', 'result', 'output', 'json', 'response', 'payload'] as const;

/** Trimmed string, or the decimal form of a finite number. Booleans are not strings. */
export function coerceToString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim().replace(/\s+/g, ' ');
    return trimmed || undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/**
 * One human-readable line from a model object.
 * `{ label, url }` becomes `"Login (https://…/login)"`. A bare label or URL is kept as-is.
 */
export function stringFromRecord(record: Record<string, unknown>): string | undefined {
  const label = firstString(record, LABEL_KEYS);
  const loc = firstString(record, LOCATION_KEYS);
  if (label && loc && label !== loc) return `${label} (${loc})`;
  if (label) return label;
  if (loc) return loc;
  return firstString(record, ['description', 'summary', 'content']);
}

function soleItem(value: unknown): unknown {
  if (Array.isArray(value) && value.length === 1) return value[0];
  return value;
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const text = coerceToString(record[key]);
    if (text) return text;
  }
  return undefined;
}

export interface StringListOptions {
  /** Drop items shorter than this. Default 1. */
  minLength?: number;
  /** Keep at most this many items, in order. Default 12. */
  maxItems?: number;
}

/**
 * Normalise a string-list field.
 *
 * Accepts a string, a number, an array (including one nested level), or one
 * object with a label / name / url / path. Null entries are dropped. Duplicate
 * lines are dropped. An unreadable non-list value returns `undefined` so the
 * field can be omitted instead of failing the rest of the object. An array
 * whose entries are all unreadable returns `[]`.
 */
export function coerceStringList(value: unknown, opts: StringListOptions = {}): string[] | undefined {
  if (value == null) return undefined;
  const minLength = opts.minLength ?? 1;
  const maxItems = opts.maxItems ?? 12;
  const collected = collectStrings(value);
  if (!collected) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of collected) {
    const text = item.trim().replace(/\s+/g, ' ');
    if (text.length < minLength) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function collectStrings(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const item of value) {
      if (item == null) continue;
      const nested = collectStrings(item);
      if (nested) out.push(...nested);
    }
    return out;
  }
  const text = textFromItem(value);
  if (text) return [text];
  if (typeof value === 'string' || typeof value === 'number') return [];
  return null;
}

function textFromItem(value: unknown): string | undefined {
  const direct = coerceToString(value);
  if (direct) return direct;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return stringFromRecord(value as Record<string, unknown>);
  }
  return undefined;
}

/** Join prose that arrived as a string, a number, a list of lines, or `{text}` / `{summary}`. */
export function coerceProse(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim().replace(/\s+/g, ' ');
    return trimmed || undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) {
    const parts = value
      .map(part => {
        if (typeof part === 'string' || typeof part === 'number') return coerceProse(part);
        if (part && typeof part === 'object' && !Array.isArray(part)) {
          return proseFromRecord(part as Record<string, unknown>);
        }
        return undefined;
      })
      .filter((part): part is string => Boolean(part));
    const joined = parts.join(' ').replace(/\s+/g, ' ').trim();
    return joined || undefined;
  }
  if (value && typeof value === 'object') return proseFromRecord(value as Record<string, unknown>);
  return undefined;
}

function proseFromRecord(record: Record<string, unknown>): string | undefined {
  for (const key of PROSE_KEYS) {
    const child = record[key];
    if (typeof child === 'string' || typeof child === 'number') {
      const text = coerceProse(child);
      if (text) return text;
    }
  }
  return undefined;
}

export function clipText(value: string, max: number): string {
  if (value.length <= max) return value;
  const sliced = value.slice(0, Math.max(0, max - 1)).trimEnd();
  return `${sliced}…`;
}

/** `"true"`, `"yes"`, `1`, and the real booleans. Anything else is undefined. */
export function coerceBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return undefined;
  }
  if (typeof value === 'string') {
    const token = value.trim().toLowerCase();
    if (token === 'true' || token === 'yes' || token === 'y' || token === '1') return true;
    if (token === 'false' || token === 'no' || token === 'n' || token === '0') return false;
  }
  return undefined;
}

/**
 * Case-insensitive enum match. Spaces and hyphens become underscores before
 * alias lookup, so `"Happy Path"` can map to `happy_path`.
 */
export function coerceEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  aliases: Record<string, T> = {},
): T | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const token = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!token) return undefined;
  if (aliases[token]) return aliases[token];
  return allowed.find(item => item === token);
}

/**
 * Models sometimes wrap the object we asked for: a one-element array, a JSON
 * string, or `{ result: { … } }`. Return the inner object when it carries one
 * of `hintKeys`. Otherwise return the value unchanged.
 */
export function unwrapModelObject(value: unknown, hintKeys: readonly string[]): unknown {
  let current = value;
  if (typeof current === 'string') {
    const trimmed = current.trim();
    const wrapped = (trimmed.startsWith('{') && trimmed.endsWith('}'))
      || (trimmed.startsWith('[') && trimmed.endsWith(']'));
    if (!wrapped) return value;
    try { current = JSON.parse(trimmed); }
    catch { return value; }
  }
  if (Array.isArray(current)) {
    if (current.length === 1) current = current[0];
    else return current;
  }
  if (!current || typeof current !== 'object' || Array.isArray(current)) return current;
  const record = current as Record<string, unknown>;
  if (hintKeys.some(key => record[key] != null && record[key] !== '')) return record;
  for (const key of ENVELOPE_KEYS) {
    const inner = soleItem(record[key]);
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      const obj = inner as Record<string, unknown>;
      if (hintKeys.some(hint => obj[hint] != null && obj[hint] !== '')) return obj;
    }
  }
  const nested = Object.values(record).filter(
    (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item),
  );
  if (nested.length === 1 && hintKeys.some(hint => nested[0][hint] != null && nested[0][hint] !== '')) {
    return nested[0];
  }
  return record;
}

/** Technical detail for server logs. User-facing events stay on `message`. */
export function logModelDetail(scope: string, detail: string): void {
  console.warn(`[monkeytester] ${scope}: ${detail}`);
}
