/**
 * Run-vs-run diff.
 *
 * The whole point of MonkeyTest's bug-finding loop is that you can answer:
 *
 *   "I ran tests yesterday, fixed the 3 reported bugs, ran them again today
 *    — what's new, what's gone, and what came back?"
 *
 * Bug `fingerprint` is intentionally stable across runs (action text +
 * tool + normalised error code), so the diff is just a set operation on
 * those fingerprints.
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
 * Compute the diff between two runs, keyed by stable bug fingerprint.
 *
 * Both arguments must be triaged `RunResult`s (i.e. `run.bugs[]` populated
 * with `BugReport.fingerprint`s). The deterministic triager always produces
 * stable fingerprints; the LLM polish pass is forbidden from changing them.
 */
export function diffRuns(previous: RunResult, current: RunResult): RunDiff {

  const prevByFp = new Map(previous.bugs.map(b => [b.fingerprint, b]));
  const currByFp = new Map(current.bugs.map(b => [b.fingerprint, b]));

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
