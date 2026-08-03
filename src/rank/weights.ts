/**
 * Every tunable in the ranking, in one place, with the reasoning attached.
 *
 * This is a preference function, not a measurement. The score has no units and predicts nothing —
 * it orders candidates according to what is written here, and the `why` command shows exactly which
 * lines produced any given position. When a recommendation is bad, the breakdown tells you which
 * number lied, and you change it here. That is the whole design: an opaque score you cannot argue
 * with is worse than no score.
 *
 * Nothing in this file is calibrated. It is a starting position, and the decisions journal is what
 * eventually replaces guesses with evidence.
 */

/**
 * Languages you actually want to work in, and how much you want each. Repo primary language is the
 * signal. Anything unlisted scores zero rather than negative — an unfamiliar language is a cost, not
 * a disqualification, and the setup and responsiveness signals already carry real risk.
 */
export const LANGUAGE_POINTS: Record<string, number> = {
  TypeScript: 14,
  Python: 14,
  Go: 8,
  JavaScript: 6,
  Java: 6,
  Rust: 4,
};

/** Labels that mean a maintainer has explicitly invited outside work. */
export const INVITED_LABELS = [
  'good first issue',
  'good-first-issue',
  'help wanted',
  'help-wanted',
  'up-for-grabs',
  'e-easy',
  'beginner friendly',
];

/** Labels worth a smaller bump: scoped, verifiable work. */
export const TRACTABLE_LABELS = ['documentation', 'docs', 'bug', 'test', 'tests', 'good first review'];

/**
 * Labels that predict a bad time regardless of everything else: design debates, blocked work, and
 * issues the maintainers have already flagged as contentious or stale.
 */
export const AVOID_LABELS = [
  'blocked',
  'needs design',
  'design',
  'discussion',
  'rfc',
  'wontfix',
  'stale',
  'needs triage',
  'question',
  'duplicate',
  'epic',
  'meta',
];

/**
 * Title patterns that reveal scope. The ranking exists to answer "is this worth my next five hours",
 * and nothing else in the score knows the difference between a one-line documentation fix and
 * "Master FR: Pen, Stylus, Handwriting and Drawing Tablet Support" — which sat at position two of a
 * real shortlist, invited label and all.
 *
 * These are read against the issue title only. A feature request can be perfectly legitimate work;
 * it is simply not a five-hour contribution, and it should not outrank one.
 */
export const SCOPE_PATTERNS: { pattern: RegExp; points: number; label: string }[] = [
  { pattern: /^\s*(master\s+)?\[?\s*(fr|feature[\s-]?request|feature|request|enhancement req)\s*[:\]]/i, points: -20, label: 'feature request' },
  { pattern: /^\s*\[?\s*(rfc|epic|meta|umbrella|tracking|roadmap)\s*[:\]]/i, points: -24, label: 'tracking or RFC issue' },
  { pattern: /^\s*\[?\s*(discussion|proposal|design|idea)\s*[:\]]/i, points: -18, label: 'design discussion' },
  { pattern: /^\s*\p{Emoji_Presentation}*\s*(decide|figure out|settle|agree on)\b/iu, points: -18, label: 'decision to be made' },
  { pattern: /\b(tracking issue|umbrella issue|master issue|meta issue)\b/i, points: -24, label: 'umbrella issue' },
  { pattern: /^\s*(rewrite|redesign|refactor all|migrate everything)\b/i, points: -16, label: 'large rewrite' },
];

export const WEIGHTS = {
  /**
   * Issue mills: repositories that auto-generate large numbers of trivial tasks labelled
   * `good first issue` so that contributors can farm activity counts.
   *
   * One took two of the top five slots on a real shortlist with eighteen more queued — issue
   * numbers in the twenty-six thousands for a small app, titles like "Add new Video Game Quote 50",
   * a dozen opened the same day. Every individual signal reads as excellent: invited label,
   * uncontested, maintainer-filed, fresh, fast responses. The pattern is only visible across issues,
   * which is why this needs repository context rather than per-issue fields.
   *
   * A penalty rather than a gate: it is heavy enough to clear the top of the list while staying
   * visible in the breakdown, because a legitimate project running a labelling sprint could trip it.
   */
  issueMill: { invitedWithinDays: 7, atLeast: 8, points: -35 },

  // --- maintainer attention (Slice 2) -------------------------------------
  /**
   * Someone is home. `dormant` is a hard gate in the query rather than a penalty here, because no
   * amount of good setup or label fit compensates for nobody reading your PR.
   */
  responsiveness: {
    responsive: 22,
    moderate: 14,
    slow: 5,
    unknown: 0,
    dormant: -40,
  } as Record<string, number>,

  /**
   * Repo signals get halved when the sample behind them is thin. A `responsive` verdict off four
   * external PRs is not the same claim as one off thirty.
   */
  lowConfidenceMultiplier: 0.5,

  /**
   * Merge rate lives here rather than in the responsiveness bucket, because the two say different
   * things and collapsing them loses the distinction. Observed in the corpus: a project answering
   * every outside PR within two hours and closing ten of sixteen unmerged. Fast triage is not the
   * same as a project that lands your work, and it reads as `responsive` either way.
   */
  mergeRate: {
    /** Of decided external PRs. Needs a real denominator before it means anything. */
    minDecidedForSignal: 6,
    generous: { threshold: 0.6, points: 16 },
    mixed: { threshold: 0.3, points: 7 },
    /** Answers, then closes. The expensive failure this ranking exists to avoid. */
    unwelcoming: { threshold: 0.15, points: -26 },
  },

  /** A queue where most outsiders are simply ignored, even if the few answered were answered fast. */
  ignoreRate: { threshold: 0.4, points: -12 },

  // --- setup cost (Slice 3) -----------------------------------------------
  /**
   * `unknown` scores zero, not negative: Slice 3 reads root-level files only, so an unmeasured repo
   * is unmeasured rather than complicated. Do not let a limitation masquerade as a finding.
   */
  setupWeight: {
    light: 12,
    moderate: 3,
    heavy: -14,
    unknown: 0,
  } as Record<string, number>,

  /**
   * Counted separately from setup weight on purpose. A heavy project with a devcontainer and a
   * Makefile is a different proposition from a heavy one with neither.
   */
  mitigations: {
    devcontainer: 6,
    taskRunner: 3,
    contributing: 4,
    /** You can see your change validated before a human ever looks at it. */
    ciOnPullRequest: 5,
  },

  // --- the issue itself ---------------------------------------------------
  invitedLabel: 16,
  tractableLabel: 5,
  avoidLabel: -14,

  /**
   * Comment count as a proxy for contention. A quiet issue is unclaimed; a busy one is usually
   * either already being worked by someone who did not self-assign, or a design argument.
   */
  comments: {
    quiet: { atMost: 3, points: 6 },
    busy: { atLeast: 12, points: -10 },
  },

  /**
   * Age cuts both ways. Very fresh issues are unclaimed but may not be triaged yet; very old ones
   * are usually open for a reason nobody wrote down.
   */
  age: {
    fresh: { withinDays: 45, points: 5 },
    stale: { afterDays: 365, points: -10 },
  },

  /** Maintainer-filed issues tend to be specified well enough to actually start on. */
  authoredByMaintainer: 6,

  /**
   * A two-line issue body is a conversation you have not had yet. Not disqualifying, but it means
   * the five hours starts with clarification rather than code.
   */
  body: {
    thin: { underChars: 200, points: -8 },
    substantial: { overChars: 600, points: 3 },
    /**
     * Past a certain length a body is a specification, not a task. Rewarding size without a ceiling
     * pushed epics up the list.
     */
    sprawling: { overChars: 5000, points: -12 },
  },

  /**
   * Very large projects have crowded queues and long review chains; very small ones carry
   * abandonment risk that the responsiveness metrics may not have caught yet.
   */
  stars: {
    sweetSpot: { min: 1000, max: 30000, points: 4 },
    huge: { over: 60000, points: -6 },
  },
} as const;

/** Rows scoring below this are noise; shown only with --min-score 0 or lower. */
export const DEFAULT_MIN_SCORE = 20;
