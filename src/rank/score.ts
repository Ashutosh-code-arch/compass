import { normaliseTerm, resolveProfile, type ResolvedProfile } from './profile.ts';
import {
  AVOID_LABELS,
  DEFAULT_MIN_SCORE,
  INVITED_LABELS,
  LANGUAGE_POINTS,
  SCOPE_PATTERNS,
  TRACTABLE_LABELS,
  WEIGHTS,
} from './weights.ts';
import { resolveWeights, type Weights } from './weight_sets.ts';

/** Everything the score can see. Nullable fields mean "not measured", never "zero". */
export interface Candidate {
  issueId: number;
  repoFullName: string;
  number: number;
  title: string;
  labels: string[];
  commentCount: number;
  createdAtGh: string;
  authorAssociation: string | null;
  bodyLength: number;
  htmlUrl: string;

  primaryLanguage: string | null;
  /** GitHub repo topics, lowercase by convention. Matched against the profile. */
  topics: string[];
  stars: number;

  responsiveness: string | null;
  confidence: string | null;
  medianHoursResponse: number | null;
  noResponseRate: number | null;
  mergeRate: number | null;
  mergedPrs: number | null;
  closedUnmergedPrs: number | null;

  setupWeight: string | null;
  composeServices: number | null;
  envVarCount: number | null;
  hasDevcontainer: boolean | null;
  taskRunner: string | null;
  hasContributing: boolean | null;
  ciRunsOnPr: boolean | null;
  /**
   * cla | dco | both | none, or null for unmeasured.
   *
   * Carried but deliberately NOT scored. Whether a CLA is a blocker or an irrelevance is entirely a
   * property of the person, not of the project — an employee of a company with a signed corporate
   * agreement pays nothing for it, and someone else cannot contribute at all. A weight would encode
   * one of those as universal. It is shown, and Phase 4's profile is where it becomes a filter.
   */
  contributorAgreement: string | null;

  /**
   * Current state: facts that DECAY, and none of which is scored.
   *
   * Phase 2 adds five of these and deliberately adds no weights. Two reasons, and the second is the
   * real one.
   *
   * First, a claim verdict exists only for issues somebody has checked. Scoring it would rank a checked
   * issue differently from an identical unchecked one, for reasons that have nothing to do with either
   * issue — the ordering would encode how you had spent your requests.
   *
   * Second, and more importantly: the weights already in `weights.ts` are beliefs written as
   * arithmetic and NOT ONE of them has been validated against an outcome. Adding six more unvalidated
   * numbers would not make the ranking better, it would make it harder to tell whether it works at
   * all. These are shown next to the score, with their age, and the reader decides.
   */
  updatedAtGh: string | null;
  /** Every open pull request in the repository. Not `open_prs`, which counts a sampled subset. */
  openPrTotal: number | null;
  oldestOpenPrAt: string | null;
  /** From the on-demand claim cache. Null means never checked, which is not the same as free. */
  claimVerdict: string | null;
  claimCheckedAt: string | null;
  claimClaimants: number | null;
}

export interface ScoreLine {
  signal: string;
  points: number;
  /** The raw value that produced the points, so the line can be argued with. */
  detail: string;
  /**
   * Whether the line describes the project or this particular issue.
   *
   * Repo lines carry the largest weights, so a breakdown sorted purely by magnitude showed the same
   * three project facts on every row — telling you why the repository was good and nothing about why
   * one issue beat another. The compact view now prefers issue lines and lets the context line carry
   * the project facts.
   */
  about: 'repo' | 'issue';
}

/**
 * Facts about a repository that only emerge from looking at its issues together.
 *
 * An issue mill's individual issues each look excellent — invited label, no comments, freshly opened,
 * filed by a maintainer. The giveaway is twenty of them appearing in a week, which no per-issue field
 * can see.
 */
export interface RepoContext {
  /** Open, invited-label issues in the candidate set created within WEIGHTS.issueMill window. */
  invitedRecent: number;
}

/** Derived from the candidate set itself, so it costs no extra queries. */
export function buildRepoContext(
  candidates: Candidate[],
  now = new Date(),
): Map<string, RepoContext> {
  // Reads the default set deliberately. Repository context is built once for the whole candidate set,
  // before any per-candidate scoring, so it cannot depend on a weight set without being rebuilt per set.
  // The issue-mill window is a description of a pattern rather than a preference, which is why that is
  // acceptable rather than a compromise.
  const cutoff = now.getTime() - WEIGHTS.issueMill.invitedWithinDays * DAY_MS;
  const context = new Map<string, RepoContext>();

  for (const candidate of candidates) {
    const entry = context.get(candidate.repoFullName) ?? { invitedRecent: 0 };
    const invited = labelMatch(candidate.labels, INVITED_LABELS) !== null;
    if (invited && new Date(candidate.createdAtGh).getTime() >= cutoff) {
      entry.invitedRecent += 1;
    }
    context.set(candidate.repoFullName, entry);
  }
  return context;
}

export interface ScoredCandidate {
  candidate: Candidate;
  score: number;
  lines: ScoreLine[];
  /** Signals that could not contribute because the underlying data is missing. */
  unmeasured: string[];
}

const DAY_MS = 86_400_000;

function labelMatch(labels: string[], wanted: string[]): string | null {
  const lower = labels.map((label) => label.toLowerCase().trim());
  for (const candidate of wanted) {
    const hit = lower.find((label) => label === candidate || label.includes(candidate));
    if (hit) return hit;
  }
  return null;
}

/**
 * Scores a candidate and records how. The breakdown is the product; the total is only there to
 * produce an order.
 */
export function scoreCandidate(
  candidate: Candidate,
  now = new Date(),
  context?: RepoContext,
  /** Defaults resolved by `resolveProfile`; omitting it scores against weights.ts exactly as before. */
  profile: ResolvedProfile = resolveProfile(),
  /**
   * The weight set. Omitting it is the default set, byte for byte what this function scored before
   * named sets existed — verified by diffing CLI output over the dev fixture, not by inspection.
   */
  W: Weights = WEIGHTS,
): ScoredCandidate {
  const lines: ScoreLine[] = [];
  const unmeasured: string[] = [];
  const add = (signal: string, points: number, detail: string, about: 'repo' | 'issue'): void => {
    if (points !== 0) lines.push({ signal, points, detail, about });
  };

  // --- maintainer attention ------------------------------------------------
  const thinSample = candidate.confidence === 'low' || candidate.confidence === 'none';
  const scaleRepo = (points: number): number =>
    thinSample ? Math.round(points * W.lowConfidenceMultiplier) : points;

  if (candidate.responsiveness) {
    const points = W.responsiveness[candidate.responsiveness] ?? 0;
    add('responsiveness',
      scaleRepo(points),
      `${candidate.responsiveness}${thinSample ? ` (confidence ${candidate.confidence}, halved)` : ''}` +
        (candidate.medianHoursResponse !== null
          ? `, median ${formatHours(candidate.medianHoursResponse)}`
          : ''),
      'repo',
    );
  } else {
    unmeasured.push('responsiveness');
  }

  if (candidate.noResponseRate !== null && candidate.noResponseRate >= W.ignoreRate.threshold) {
    add('ignore rate',
      scaleRepo(W.ignoreRate.points),
      `${Math.round(candidate.noResponseRate * 100)}% of outside PRs unanswered`,
      'repo',
    );
  }

  const decided = (candidate.mergedPrs ?? 0) + (candidate.closedUnmergedPrs ?? 0);
  if (candidate.mergeRate !== null && decided >= W.mergeRate.minDecidedForSignal) {
    const rate = candidate.mergeRate;
    const pct = `${Math.round(rate * 100)}% of ${decided} decided outside PRs merged`;
    if (rate <= W.mergeRate.unwelcoming.threshold) {
      add('merge rate', scaleRepo(W.mergeRate.unwelcoming.points), `${pct} — answers, then closes`, 'repo');
    } else if (rate >= W.mergeRate.generous.threshold) {
      add('merge rate', scaleRepo(W.mergeRate.generous.points), pct, 'repo');
    } else if (rate >= W.mergeRate.mixed.threshold) {
      add('merge rate', scaleRepo(W.mergeRate.mixed.points), pct, 'repo');
    }
  } else if (candidate.mergeRate === null) {
    unmeasured.push('merge rate');
  } else {
    unmeasured.push(`merge rate (only ${decided} decided PRs)`);
  }

  // --- setup cost ----------------------------------------------------------
  if (candidate.setupWeight && candidate.setupWeight !== 'unknown') {
    const detail = [
      candidate.setupWeight,
      candidate.composeServices !== null
        ? `${candidate.composeServices} service${candidate.composeServices === 1 ? '' : 's'}`
        : null,
      candidate.envVarCount !== null
        ? `${candidate.envVarCount} env var${candidate.envVarCount === 1 ? '' : 's'}`
        : null,
    ]
      .filter((part): part is string => part !== null)
      .join(', ');
    add('setup', W.setupWeight[candidate.setupWeight] ?? 0, detail, 'repo');
  } else {
    unmeasured.push('setup');
  }

  const mitigations: string[] = [];
  let mitigationPoints = 0;
  if (candidate.hasDevcontainer) {
    mitigationPoints += W.mitigations.devcontainer;
    mitigations.push('devcontainer');
  }
  if (candidate.taskRunner && candidate.taskRunner !== 'none') {
    mitigationPoints += W.mitigations.taskRunner;
    mitigations.push(candidate.taskRunner);
  }
  if (candidate.hasContributing) {
    mitigationPoints += W.mitigations.contributing;
    mitigations.push('CONTRIBUTING');
  }
  if (candidate.ciRunsOnPr === true) {
    mitigationPoints += W.mitigations.ciOnPullRequest;
    mitigations.push('CI on PRs');
  }
  add('onboarding', mitigationPoints, mitigations.join(', '), 'repo');

  // --- what you want to work on --------------------------------------------
  // An unlisted language scores zero rather than negative: an unfamiliar language is a cost, not a
  // disqualification, and the setup and responsiveness signals already carry the real risk.
  if (candidate.primaryLanguage) {
    const points = profile.languagePoints[normaliseTerm(candidate.primaryLanguage)] ?? 0;
    add('language', points, candidate.primaryLanguage, 'repo');
  }

  // Best single topic match, not the sum. A repo tagged react + typescript + frontend would
  // otherwise collect three payments for one fact about itself.
  const topics = candidate.topics.map(normaliseTerm);
  let bestTopic: { topic: string; points: number } | null = null;
  for (const topic of topics) {
    const points = profile.topicPoints[topic];
    if (points !== undefined && (bestTopic === null || points > bestTopic.points)) {
      bestTopic = { topic, points };
    }
  }
  if (bestTopic) add('topic', bestTopic.points, `tagged "${bestTopic.topic}"`, 'repo');

  const avoidedTopic = topics.find((topic) => profile.avoidTopics.includes(topic));
  if (avoidedTopic) {
    add('avoided subject', W.avoidLabel, `tagged "${avoidedTopic}"`, 'repo');
  }

  // --- labels --------------------------------------------------------------
  const invited = labelMatch(candidate.labels, INVITED_LABELS);
  if (invited) add('invited', W.invitedLabel, `labelled "${invited}"`, 'issue');

  const tractable = labelMatch(candidate.labels, TRACTABLE_LABELS);
  if (tractable && !invited) add('tractable', W.tractableLabel, `labelled "${tractable}"`, 'issue');

  // Profile terms extend the built-in list rather than replacing it: the built-ins encode structural
  // problems (needs-design, blocked) that are worth avoiding whatever you happen to like.
  const avoid = labelMatch(candidate.labels, [...AVOID_LABELS, ...profile.avoidLabels]);
  if (avoid) add('avoid', W.avoidLabel, `labelled "${avoid}"`, 'issue');

  // --- contention ----------------------------------------------------------
  if (candidate.commentCount <= W.comments.quiet.atMost) {
    add('uncontested', W.comments.quiet.points, `${candidate.commentCount} comment${candidate.commentCount === 1 ? '' : 's'}`, 'issue');
  } else if (candidate.commentCount >= W.comments.busy.atLeast) {
    add('contested',
      W.comments.busy.points,
      `${candidate.commentCount} comments — likely already being worked or argued over`,
      'issue',
    );
  }

  // --- age -----------------------------------------------------------------
  const ageDays = Math.floor((now.getTime() - new Date(candidate.createdAtGh).getTime()) / DAY_MS);
  if (ageDays <= W.age.fresh.withinDays) {
    add('fresh', W.age.fresh.points, `opened ${ageDays}d ago`, 'issue');
  } else if (ageDays >= W.age.stale.afterDays) {
    add('stale', W.age.stale.points, `open for ${Math.round(ageDays / 365)}y`, 'issue');
  }

  // --- specification quality -----------------------------------------------
  if (candidate.authorAssociation && ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(candidate.authorAssociation)) {
    add('maintainer-filed', W.authoredByMaintainer, candidate.authorAssociation.toLowerCase(), 'issue');
  }

  if (candidate.bodyLength < W.body.thin.underChars) {
    add('thin description', W.body.thin.points, `${candidate.bodyLength} chars`, 'issue');
  } else if (candidate.bodyLength > W.body.sprawling.overChars) {
    add('sprawling', W.body.sprawling.points, `${candidate.bodyLength} chars — a spec, not a task`, 'issue');
  } else if (candidate.bodyLength > W.body.substantial.overChars) {
    add('detailed', W.body.substantial.points, `${candidate.bodyLength} chars`, 'issue');
  }

  // --- scope ---------------------------------------------------------------
  // Nothing above distinguishes a one-line docs fix from a multi-month feature request, and an
  // invited label on an epic outranked genuinely small work.
  for (const scope of SCOPE_PATTERNS) {
    if (scope.pattern.test(candidate.title)) {
      add('scope', scope.points, `title reads as a ${scope.label}`, 'issue');
      break;
    }
  }

  // --- issue mill ----------------------------------------------------------
  // Visible only across issues: a burst of invited-label tasks opened together.
  if (context && context.invitedRecent >= W.issueMill.atLeast) {
    add(
      'issue mill',
      W.issueMill.points,
      `${context.invitedRecent} invited issues opened here within ` +
        `${W.issueMill.invitedWithinDays}d — looks auto-generated`,
      'repo',
    );
  }

  // --- project size --------------------------------------------------------
  if (candidate.stars > W.stars.huge.over) {
    add('very large project', W.stars.huge.points, `${candidate.stars.toLocaleString()} stars`, 'repo');
  } else if (candidate.stars >= W.stars.sweetSpot.min && candidate.stars <= W.stars.sweetSpot.max) {
    add('size', W.stars.sweetSpot.points, `${candidate.stars.toLocaleString()} stars`, 'repo');
  }

  const score = lines.reduce((total, line) => total + line.points, 0);
  return { candidate, score, lines, unmeasured };
}

export function formatHours(hours: number): string {
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

export function rankCandidates(
  candidates: Candidate[],
  options: { minScore?: number; now?: Date; profile?: ResolvedProfile } = {},
): ScoredCandidate[] {
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const now = options.now ?? new Date();
  const profile = options.profile ?? resolveProfile();
  // Resolved once per run. Every candidate in one ranking must be scored against the same set, or the
  // ordering compares numbers from two different models.
  const weights = resolveWeights(profile.weightSet);
  const context = buildRepoContext(candidates, now);

  return candidates
    .map((candidate) =>
      // The set comes from the profile, resolved once per run rather than per candidate.
      scoreCandidate(candidate, now, context.get(candidate.repoFullName), profile, weights),
    )
    .filter((scored) => scored.score >= minScore)
    .sort((a, b) => b.score - a.score);
}

/** The two or three lines that most account for a position, for compact display. */
export function topLines(scored: ScoredCandidate, count = 3): ScoreLine[] {
  return [...scored.lines]
    .sort((a, b) => Math.abs(b.points) - Math.abs(a.points))
    .slice(0, count);
}

/**
 * The lines that distinguish this issue from another in the same repository.
 *
 * Repo lines are excluded because they are identical for every issue in a project and are already
 * summarised on the context line. Without this, every row of a real shortlist displayed the same
 * three project facts and the panel explained nothing.
 */
export function distinguishingLines(scored: ScoredCandidate, count = 4): ScoreLine[] {
  const issueLines = scored.lines
    .filter((line) => line.about === 'issue')
    .sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  if (issueLines.length > 0) return issueLines.slice(0, count);
  // Nothing notable about the issue itself: say so rather than repeating the repo facts.
  return [];
}
