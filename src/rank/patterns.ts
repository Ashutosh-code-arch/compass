/**
 * What your own journal already knows about a repository. PURE: no database, no clock, no console.
 *
 * The observation this exists for: four rejections in one project for "needs design discussion
 * first" is that project telling you something, and it is sitting in a column you already fill in by
 * hand. No fetching, no new signal, no API budget — a `GROUP BY` over data the tool has had all
 * along.
 *
 * Two counts rather than one, because they are different warnings and the response to each differs:
 *
 *   declined  you looked and chose not to start. Usually says something about how the project files
 *             issues — under-specified, wants a design conversation first, wrong shape of work.
 *   unlanded  you started and it never landed. Says something about what happens after you push,
 *             which is the more expensive kind of wrong.
 *
 * Deliberately NOT part of the score. Judged issues are already excluded from the shortlist, so this
 * describes the project rather than the candidate, and folding it into the weights would mean the
 * ranking silently learns from a handful of hand-written notes. Six rejections is a fact worth
 * reading next to a row; it is not evidence anybody has validated as predictive, and the one place
 * this project refuses to guess is where a number would look like a measurement.
 */

/** One issue's final state in the journal, already reduced from its verdict trail. */
export interface DecidedIssue {
  repoFullName: string;
  /** The most recent verdict for that issue. */
  latestVerdict: string;
  /** The most recent non-null reason for that issue, verbatim as written. */
  reason: string | null;
}

/** You looked and did not start. */
const DECLINED_VERDICTS = new Set(['rejected']);

/**
 * You started and it did not land.
 *
 * `stalled` counts: an issue you submitted work for that nobody ever acted on cost you the same
 * hours as one that was closed, and it is a stronger statement about the project than either.
 */
const UNLANDED_VERDICTS = new Set(['abandoned', 'closed_unmerged', 'stalled']);

/**
 * How many negative outcomes before a project is described as having a pattern.
 *
 * Two, which is low, and knowingly so. Twice is a coincidence rather than a habit — but this is a
 * personal tool that will accumulate a few dozen decisions over months, not thousands, and a
 * threshold of five would mean the feature stayed silent through the entire period it was most
 * useful. The count is always shown alongside, so the reader can discount two as easily as the code
 * could have.
 */
export const MIN_PATTERN_DECISIONS = 2;

/** How many times a reason must repeat before it is called a repeated reason. */
export const MIN_REASON_REPEATS = 2;

export interface RepeatedReason {
  /** Verbatim, from the most recent decision in the group. Not the normalised form. */
  reason: string;
  count: number;
}

export interface RepoPattern {
  repoFullName: string;
  declined: number;
  unlanded: number;
  /** The most repeated reason across both kinds, when any reason repeats. */
  repeatedReason: RepeatedReason | null;
}

/**
 * Reduces a written reason to a grouping key.
 *
 * The point is to let "Needs design discussion first" and "needs design discussion first." land in
 * the same group, not to understand English. Anything cleverer — stemming, keyword extraction,
 * fuzzy matching — would start merging reasons that are genuinely different and there would be no way
 * to tell from the output that it had happened. Exact-after-tidying is a rule a reader can predict.
 */
export function normaliseReason(reason: string): string {
  return reason
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    // Trailing punctuation only. Interior punctuation can carry meaning ("won't fix, upstream bug").
    .replace(/[.!?;,]+$/, '')
    .trim();
}

/**
 * Per-repository patterns, keyed by full name.
 *
 * Takes one entry per decided ISSUE rather than per journal row. A single issue can carry
 * `started -> abandoned`, and counting rows would report one abandonment as two.
 */
export function buildRepoPatterns(decided: DecidedIssue[]): Map<string, RepoPattern> {
  interface Accumulator {
    declined: number;
    unlanded: number;
    /** Normalised key -> count, and the verbatim text most recently seen for it. */
    reasons: Map<string, { count: number; verbatim: string }>;
  }

  const byRepo = new Map<string, Accumulator>();

  for (const issue of decided) {
    const declined = DECLINED_VERDICTS.has(issue.latestVerdict);
    const unlanded = UNLANDED_VERDICTS.has(issue.latestVerdict);
    // A merged or in-progress issue is not a warning about anything, and neither is a bare
    // `shortlisted`. Only negative outcomes contribute.
    if (!declined && !unlanded) continue;

    const accumulator =
      byRepo.get(issue.repoFullName) ??
      { declined: 0, unlanded: 0, reasons: new Map<string, { count: number; verbatim: string }>() };

    if (declined) accumulator.declined += 1;
    if (unlanded) accumulator.unlanded += 1;

    const reason = issue.reason?.trim();
    if (reason) {
      const key = normaliseReason(reason);
      if (key !== '') {
        const existing = accumulator.reasons.get(key);
        // Callers pass most-recent-first, so the first sighting of a key is the newest wording; keep
        // that one rather than overwriting it with older phrasings of the same thing.
        accumulator.reasons.set(key, {
          count: (existing?.count ?? 0) + 1,
          verbatim: existing?.verbatim ?? reason,
        });
      }
    }

    byRepo.set(issue.repoFullName, accumulator);
  }

  const patterns = new Map<string, RepoPattern>();
  for (const [repoFullName, accumulator] of byRepo) {
    if (accumulator.declined + accumulator.unlanded < MIN_PATTERN_DECISIONS) continue;

    let repeated: RepeatedReason | null = null;
    for (const entry of accumulator.reasons.values()) {
      if (entry.count < MIN_REASON_REPEATS) continue;
      if (repeated === null || entry.count > repeated.count) {
        repeated = { reason: entry.verbatim, count: entry.count };
      }
    }

    patterns.set(repoFullName, {
      repoFullName,
      declined: accumulator.declined,
      unlanded: accumulator.unlanded,
      repeatedReason: repeated,
    });
  }

  return patterns;
}
