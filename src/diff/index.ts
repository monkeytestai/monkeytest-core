/**
 * Run-vs-run diff.
 *
 * The whole point of MonkeyTest's bug-finding loop is that you can answer:
 *
 *   "I ran tests yesterday, fixed the 3 reported bugs, ran them again today
 *    — what's new, what's gone, and what came back?"
 *
 * When both runs carry `fingerprintV2`, that stable hash is the identity
 * (category, URL template, role + name, error signal — not the tool).
 * Otherwise the diff uses `fingerprint`, the legacy v1 hash. A stored bug
 * that only has v1 therefore still matches a new bug with the same v1
 * value, instead of showing up as fixed and new.
 */

import type { BugReport, RunResult } from '../types.js';

export type RunDiffStatus = 'new' | 'fixed' | 'persisting' | 'regressed';

export interface BugDiffEntry {
  /** Stable cross-run identity. */
  fingerprint: string;
  /** What happened to this bug between `previous` and `current`. */
  status: RunDiffStatus;
  /** Severity at the more recent appearance (current for new/persisting/regressed; previous for fixed). */
  severity: BugReport['severity'];
  /** Most recent bug record (current for new/persisting/regressed; previous for fixed). */
  bug: BugReport;
  /** Previous bug record, if known and different from `bug`. */
  previous?: BugReport;
}

export interface RunDiff {
  /** Bugs in `current` whose fingerprint did NOT appear in `previous`. */
  newBugs: BugDiffEntry[];
  /** Bugs in `previous` whose fingerprint is no longer in `current`. */
  fixedBugs: BugDiffEntry[];
  /**
   * Bugs whose fingerprint appears in BOTH runs and severity did not change.
   * "Still broken — and not getting worse."
   */
  persistingBugs: BugDiffEntry[];
  /**
   * Bugs whose fingerprint appears in BOTH runs but severity got *worse*
   * (minor → major → critical). Treat these as priority-1 in CI.
   */
  regressedBugs: BugDiffEntry[];
  /** Convenience tallies for headlines. */
  stats: {
    new: number;
    fixed: number;
    persisting: number;
    regressed: number;
    /** Net change in bug count (current.bugs - previous.bugs). Negative = improvement. */
    delta: number;
  };
}

const SEVERITY_RANK: Record<BugReport['severity'], number> = {
  minor: 1,
  major: 2,
  critical: 3,
};

/**
 * Identity used by the diff.
 *
 * Pass `preferV2: true` only when every bug on both sides has
 * `fingerprintV2`. Otherwise this returns the legacy `fingerprint`, which
 * is what hosts already store and compare.
 */
export function bugFingerprint(bug: BugReport, preferV2 = false): string {
  if (preferV2 && bug.fingerprintV2) return bug.fingerprintV2;
  return bug.fingerprint;
}

/** True when a `--bug` value names either the legacy hash or `fingerprintV2`. */
export function bugMatchesFingerprint(bug: BugReport, fingerprint: string): boolean {
  return bug.fingerprint === fingerprint || bug.fingerprintV2 === fingerprint;
}

function bothSidesHaveV2(previous: RunResult, current: RunResult): boolean {
  const bugs = [...previous.bugs, ...current.bugs];
  return bugs.length > 0 && bugs.every(bug => !!bug.fingerprintV2);
}

/**
 * Compute the diff between two runs, keyed by stable bug fingerprint.
 *
 * Both arguments must be triaged `RunResult`s (i.e. `run.bugs[]` populated
 * with `BugReport.fingerprint`s). The deterministic triager always produces
 * stable fingerprints; the LLM polish pass is forbidden from changing them.
 */
export function diffRuns(previous: RunResult, current: RunResult): RunDiff {

  const preferV2 = bothSidesHaveV2(previous, current);
  const prevByFp = new Map(previous.bugs.map(b => [bugFingerprint(b, preferV2), b]));
  const currByFp = new Map(current.bugs.map(b => [bugFingerprint(b, preferV2), b]));

  const newBugs: BugDiffEntry[] = [];
  const fixedBugs: BugDiffEntry[] = [];
  const persistingBugs: BugDiffEntry[] = [];
  const regressedBugs: BugDiffEntry[] = [];

  for (const [fp, currentBug] of currByFp){
    const prev = prevByFp.get(fp);
    if (!prev){
      newBugs.push({
        fingerprint: fp,
        status: 'new',
        severity: currentBug.severity,
        bug: currentBug,
      });
      continue;
    }
    if (SEVERITY_RANK[currentBug.severity] > SEVERITY_RANK[prev.severity]){
      regressedBugs.push({
        fingerprint: fp,
        status: 'regressed',
        severity: currentBug.severity,
        bug: currentBug,
        previous: prev,
      });
    } else {
      persistingBugs.push({
        fingerprint: fp,
        status: 'persisting',
        severity: currentBug.severity,
        bug: currentBug,
        previous: prev,
      });
    }
  }

  for (const [fp, prevBug] of prevByFp){
    if (!currByFp.has(fp)){
      fixedBugs.push({
        fingerprint: fp,
        status: 'fixed',
        severity: prevBug.severity,
        bug: prevBug,
      });
    }
  }

  return {
    newBugs,
    fixedBugs,
    persistingBugs,
    regressedBugs,
    stats: {
      new:        newBugs.length,
      fixed:      fixedBugs.length,
      persisting: persistingBugs.length,
      regressed:  regressedBugs.length,
      delta:      current.bugs.length - previous.bugs.length,
    },
  };

}

/**
 * Human-readable one-liner. Useful for CLI output and chat notifications.
 *
 *   `1 new, 2 fixed, 3 still broken, 0 regressed (net -1)`
 */
export function summariseDiff(diff: RunDiff): string {
  const { stats } = diff;
  const sign = stats.delta > 0 ? `+${stats.delta}` : `${stats.delta}`;
  return `${stats.new} new, ${stats.fixed} fixed, ${stats.persisting} still broken, ${stats.regressed} regressed (net ${sign})`;
}
