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
): ScoredCandidate {
  const lines: ScoreLine[] = [];
  const unmeasured: string[] = [];
  const add = (signal: string, points: number, detail: string, about: 'repo' | 'issue'): void => {
    if (points !== 0) lines.push({ signal, points, detail, about });
  };

  // --- maintainer attention ------------------------------------------------
  const thinSample = candidate.confidence === 'low' || candidate.confidence === 'none';
  const scaleRepo = (points: number): number =>
    thinSample ? Math.round(points * WEIGHTS.lowConfidenceMultiplier) : points;

  if (candidate.responsiveness) {
    const points = WEIGHTS.responsiveness[candidate.responsiveness] ?? 0;
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

  if (candidate.noResponseRate !== null && candidate.noResponseRate >= WEIGHTS.ignoreRate.threshold) {
    add('ignore rate',
      scaleRepo(WEIGHTS.ignoreRate.points),
      `${Math.round(candidate.noResponseRate * 100)}% of outside PRs unanswered`,
      'repo',
    );
  }

  const decided = (candidate.mergedPrs ?? 0) + (candidate.closedUnmergedPrs ?? 0);
  if (candidate.mergeRate !== null && decided >= WEIGHTS.mergeRate.minDecidedForSignal) {
    const rate = candidate.mergeRate;
    const pct = `${Math.round(rate * 100)}% of ${decided} decided outside PRs merged`;
    if (rate <= WEIGHTS.mergeRate.unwelcoming.threshold) {
      add('merge rate', scaleRepo(WEIGHTS.mergeRate.unwelcoming.points), `${pct} — answers, then closes`, 'repo');
    } else if (rate >= WEIGHTS.mergeRate.generous.threshold) {
      add('merge rate', scaleRepo(WEIGHTS.mergeRate.generous.points), pct, 'repo');
    } else if (rate >= WEIGHTS.mergeRate.mixed.threshold) {
      add('merge rate', scaleRepo(WEIGHTS.mergeRate.mixed.points), pct, 'repo');
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
    add('setup', WEIGHTS.setupWeight[candidate.setupWeight] ?? 0, detail, 'repo');
  } else {
    unmeasured.push('setup');
  }

  const mitigations: string[] = [];
  let mitigationPoints = 0;
  if (candidate.hasDevcontainer) {
    mitigationPoints += WEIGHTS.mitigations.devcontainer;
    mitigations.push('devcontainer');
  }
  if (candidate.taskRunner && candidate.taskRunner !== 'none') {
    mitigationPoints += WEIGHTS.mitigations.taskRunner;
    mitigations.push(candidate.taskRunner);
  }
  if (candidate.hasContributing) {
    mitigationPoints += WEIGHTS.mitigations.contributing;
    mitigations.push('CONTRIBUTING');
  }
  if (candidate.ciRunsOnPr === true) {
    mitigationPoints += WEIGHTS.mitigations.ciOnPullRequest;
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
    add('avoided subject', WEIGHTS.avoidLabel, `tagged "${avoidedTopic}"`, 'repo');
  }

  // --- labels --------------------------------------------------------------
  const invited = labelMatch(candidate.labels, INVITED_LABELS);
  if (invited) add('invited', WEIGHTS.invitedLabel, `labelled "${invited}"`, 'issue');

  const tractable = labelMatch(candidate.labels, TRACTABLE_LABELS);
  if (tractable && !invited) add('tractable', WEIGHTS.tractableLabel, `labelled "${tractable}"`, 'issue');

  // Profile terms extend the built-in list rather than replacing it: the built-ins encode structural
  // problems (needs-design, blocked) that are worth avoiding whatever you happen to like.
  const avoid = labelMatch(candidate.labels, [...AVOID_LABELS, ...profile.avoidLabels]);
  if (avoid) add('avoid', WEIGHTS.avoidLabel, `labelled "${avoid}"`, 'issue');

  // --- contention ----------------------------------------------------------
  if (candidate.commentCount <= WEIGHTS.comments.quiet.atMost) {
    add('uncontested', WEIGHTS.comments.quiet.points, `${candidate.commentCount} comment${candidate.commentCount === 1 ? '' : 's'}`, 'issue');
  } else if (candidate.commentCount >= WEIGHTS.comments.busy.atLeast) {
    add('contested',
      WEIGHTS.comments.busy.points,
      `${candidate.commentCount} comments — likely already being worked or argued over`,
      'issue',
    );
  }

  // --- age -----------------------------------------------------------------
  const ageDays = Math.floor((now.getTime() - new Date(candidate.createdAtGh).getTime()) / DAY_MS);
  if (ageDays <= WEIGHTS.age.fresh.withinDays) {
    add('fresh', WEIGHTS.age.fresh.points, `opened ${ageDays}d ago`, 'issue');
  } else if (ageDays >= WEIGHTS.age.stale.afterDays) {
    add('stale', WEIGHTS.age.stale.points, `open for ${Math.round(ageDays / 365)}y`, 'issue');
  }

  // --- specification quality -----------------------------------------------
  if (candidate.authorAssociation && ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(candidate.authorAssociation)) {
    add('maintainer-filed', WEIGHTS.authoredByMaintainer, candidate.authorAssociation.toLowerCase(), 'issue');
  }

  if (candidate.bodyLength < WEIGHTS.body.thin.underChars) {
    add('thin description', WEIGHTS.body.thin.points, `${candidate.bodyLength} chars`, 'issue');
  } else if (candidate.bodyLength > WEIGHTS.body.sprawling.overChars) {
    add('sprawling', WEIGHTS.body.sprawling.points, `${candidate.bodyLength} chars — a spec, not a task`, 'issue');
  } else if (candidate.bodyLength > WEIGHTS.body.substantial.overChars) {
    add('detailed', WEIGHTS.body.substantial.points, `${candidate.bodyLength} chars`, 'issue');
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
  if (context && context.invitedRecent >= WEIGHTS.issueMill.atLeast) {
    add(
      'issue mill',
      WEIGHTS.issueMill.points,
      `${context.invitedRecent} invited issues opened here within ` +
        `${WEIGHTS.issueMill.invitedWithinDays}d — looks auto-generated`,
      'repo',
    );
  }

  // --- project size --------------------------------------------------------
  if (candidate.stars > WEIGHTS.stars.huge.over) {
    add('very large project', WEIGHTS.stars.huge.points, `${candidate.stars.toLocaleString()} stars`, 'repo');
  } else if (candidate.stars >= WEIGHTS.stars.sweetSpot.min && candidate.stars <= WEIGHTS.stars.sweetSpot.max) {
    add('size', WEIGHTS.stars.sweetSpot.points, `${candidate.stars.toLocaleString()} stars`, 'repo');
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
  const context = buildRepoContext(candidates, now);

  return candidates
    .map((candidate) =>
      scoreCandidate(candidate, now, context.get(candidate.repoFullName), profile),
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
