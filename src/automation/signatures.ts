/**
 * Signatures for failures that are ours, not the site's.
 *
 * mtaiclient `confirmedBugs.js` (`isSoftExploratoryBug`) and mtaiserver use
 * the same idea to drop our Playwright mistakes from confirmed bugs. This
 * module is the superset: every bug that file would drop is dropped here,
 * and so are the runner errors that file does not name (Cannot type text
 * into `input[type=number]`, InvalidSelector, strict mode, detached nodes,
 * and selector timeouts) even when a host stored them as critical.
 *
 * A real site failure is never dropped: HTTP 5xx, an uncaught page error,
 * a disabled control the step tried to use, or a document HTTP 404.
 */

export interface AutomationFaultSignature {
  /** Stable id. Safe to store and to show in a report. */
  id: string;
  /**
   * JavaScript regular expression source, matched case-insensitively against
   * the bug or step text (title, observed, expected, triage notes, error).
   */
  pattern: string;
  /** What the signature catches, for hosts reimplementing the check. */
  description: string;
  /**
   * `text` (default) — `isAutomationFault` tests the pattern against the
   * whole bug or step text.
   * `client` — documented for parity, but the match is the two-part title
   * and body rule in `matchesClientSoftExploratory`. A bare `timeout` must
   * not drop every slow page.
   */
  match?: 'text' | 'client';
}

/**
 * Patterns that mean the runner failed, not the site. `client-page-title`
 * and `client-soft-timeout` are the two rules in mtaiclient
 * `isSoftExploratoryBug`, expressed as the same checks `matchesClientSoftExploratory`
 * runs (the timeout rule also looks at the title, which a single body regex
 * cannot). The rest are the core superset.
 */
export const AUTOMATION_FAULT_SIGNATURES: readonly AutomationFaultSignature[] = [
  {
    id: 'cannot-type-text',
    pattern: 'cannot type text into input',
    description: 'Playwright refused fill() because the value is not valid for input[type=number] (for example "555-0100").',
  },
  {
    id: 'not-an-input',
    pattern: 'not an <input|<textarea>|<select>|\\[contenteditable\\]|not editable|cannot be filled',
    description: 'The locator resolved to an element Playwright cannot type into.',
  },
  {
    id: 'invalid-selector',
    pattern: 'invalid selector|invalidselector|unexpected token .+ while parsing css selector',
    description: 'The selector was invalid. That is the runner\'s locator, not a broken page.',
  },
  {
    id: 'strict-mode',
    pattern: 'strict mode violation',
    description: 'The selector matched more than one element.',
  },
  {
    id: 'detached',
    pattern: 'not attached to the dom|element is detached|detached from (the )?document',
    description: 'The element went away before the action ran.',
  },
  {
    id: 'target-not-found',
    pattern: 'waiting for locator|resolved to \\d+ elements|no element|no node',
    description: 'A selector the runner built matched nothing, or the wait was for that selector.',
  },
  {
    id: 'selector-timeout',
    pattern: 'locator\\.(fill|click|press|waitfor)|timeout \\d+ms exceeded[\\s\\S]{0,160}locator|waiting for (getby|locator)',
    description: 'A timeout caused by our selector (locator.fill / locator.click / getBy*), not a server timeout.',
  },
  {
    id: 'client-page-title',
    pattern: '(page title|document title).{0,80}(assert|expected to see|check if)|check if the page title',
    description: 'Same page-title observation mtaiclient drops. Exploratory, not a product bug.',
  },
  {
    id: 'client-soft-timeout',
    pattern: '(waiting for locator|locator\\.fill|timeout)',
    description: 'Body half of the mtaiclient rule. Not applied as a bare text search. matchesClientSoftExploratory also requires the title to match /could not|not found|timeout|locator/ and the severity to be anything but critical.',
    match: 'client',
  },
] as const;

const COMPILED = AUTOMATION_FAULT_SIGNATURES
  .filter(signature => signature.match !== 'client')
  .map(signature => ({
    ...signature,
    regex: new RegExp(signature.pattern, 'i'),
  }));

export interface BugText {
  severity?: string;
  title?: string;
  observed?: string;
  expected?: string;
  triageNotes?: string;
  /** Wire name used by mtaiclient / mtaiserver. */
  triage_notes?: string;
  error?: string;
}

function combined(bug: BugText): string {
  return [
    bug.title,
    bug.observed,
    bug.expected,
    bug.triageNotes,
    bug.triage_notes,
    bug.error,
  ].filter(Boolean).join('\n');
}

/** First core signature id that matches, if any. */
export function automationFaultId(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const hit = COMPILED.find(signature => signature.regex.test(text));
  return hit?.id;
}

/** True when the text is one of our Playwright / exploratory misses. */
export function isAutomationFault(text: string | undefined): boolean {
  return automationFaultId(text) !== undefined;
}

/**
 * Exact mtaiclient `isSoftExploratoryBug` rule, including its critical
 * exemption. Hosts that only want parity with the current client can call
 * this. `isOwnAutomationBug` is the superset the engine uses.
 */
export function matchesClientSoftExploratory(bug: BugText): boolean {
  if (bug.severity === 'critical') return false;
  const title = String(bug.title || '').toLowerCase();
  const text = [bug.title, bug.observed, bug.expected, bug.triageNotes, bug.triage_notes]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (/page title|document title/.test(text) && /assert|expected to see|check if/.test(text)) return true;
  if (text.includes('check if the page title')) return true;
  const automationMiss = (text.includes('waiting for locator') || text.includes('locator.fill') || text.includes('timeout'))
    && /could not|not found|timeout|locator/.test(title);
  return automationMiss;
}

/** HTTP 5xx, uncaught page error, disabled control, or document HTTP 404. */
export function isRealSiteFailureText(text: string | undefined): boolean {
  const raw = (text || '').toLowerCase();
  if (!raw.trim()) return false;
  if (/\bhttp-5\d\d\b/.test(raw)) return true;
  if (/returned http 5\d\d/.test(raw) || /\bhttp 5\d\d\b/.test(raw)) return true;
  if (raw.includes('internal server error')) return true;
  if (raw.includes('pageerror') || raw.includes('uncaught page error')) return true;
  if (raw.includes('element-disabled') || raw.includes('control is disabled')) return true;
  if (raw.includes('http-404') || /returned http 404/.test(raw) || /document .{0,80}http 404/.test(raw)) return true;
  return false;
}

/**
 * True when this bug must not be confirmed. Real site failures return false
 * even if the wording also mentions a timeout. Critical severity does not
 * protect a pure Playwright error (superset of the client, which keeps every
 * critical row).
 */
export function isOwnAutomationBug(bug: BugText): boolean {
  const text = combined(bug);
  if (isRealSiteFailureText(text)) return false;
  if (matchesClientSoftExploratory(bug)) return true;
  if (isAutomationFault(text)) return true;
  return false;
}
