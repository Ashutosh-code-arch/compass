/**
 * Presentation models for the ranking commands. PURE: no database, no console, no clock beyond the
 * `now` that is passed in.
 *
 * This is the layer that was previously interleaved with `console.log` inside `rank/report.ts`. The
 * per-repo cap, the summary statistics, the repo/issue split in `why`, and the prediction/outcome
 * pairing in `journal` are all judgement calls, and this project's rule is that anything with
 * judgement in it lives somewhere it can be tested without a network or a database.
 *
 * The CLI renderer and the HTTP layer both consume these structures. Neither prose nor padding
 * belongs here.
 */

import {
  buildRepoContext,
  distinguishingLines,
  rankCandidates,
  scoreCandidate,
  type Candidate,
  type RepoContext,
  type ScoreLine,
} from './score.ts';
import { DEFAULT_MIN_SCORE } from './weights.ts';
import { bountyLabels } from '../claims/detect.ts';
import { describeMomentum, type RepoMomentum } from '../velocity/index.ts';
import { resolveWeights } from './weight_sets.ts';
import type { RepoPattern } from './patterns.ts';
import type { ResolvedProfile } from './profile.ts';

// ---------------------------------------------------------------------------
// shortlist
// ---------------------------------------------------------------------------

export interface ShortlistViewOptions {
  limit?: number;
  /** Rows to skip, after ranking and after the per-repo cap. */
  offset?: number;
  minScore?: number;
  /**
   * Maximum rows from any one repository.
   *
   * Repo-level signals dominate the score, so a single project with a large labelled backlog takes
   * over the list — one real run returned twelve of its top twenty from the same repository, all on
   * an identical score. The point of a shortlist is a set of distinct options.
   */
  perRepo?: number;
  /** The cap `fetchCandidates` was called with, so the view can report having hit it. */
  fetchLimit?: number;
  /** Defaults resolved. Omitting it scores against weights.ts, exactly as before the profile. */
  profile?: ResolvedProfile;
  /**
   * What your journal already says about each repository, keyed by full name.
   *
   * Passed in rather than derived from the candidates, because by construction it cannot be: a
   * judged issue is gated out of the candidate set, so every decision this describes belongs to an
   * issue that is no longer here.
   */
  patterns?: Map<string, RepoPattern>;
  /**
   * Star velocity and the momentum verdict, keyed by repository full name.
   *
   * Passed in rather than derived, because it comes from `repo_stars_history` rather than from anything
   * on a candidate row — and because a missing key has to stay missing. A repository with no measured
   * velocity is not a repository that is not growing.
   */
  momentum?: Map<string, RepoMomentum>;
  /** Keep only rows whose repository has this momentum verdict. */
  momentumFilter?: string;
  now?: Date;
}

export const DEFAULT_LIMIT = 20;
export const DEFAULT_PER_REPO = 2;
export const DEFAULT_FETCH_LIMIT = 50000;

/** The repo facts that sit under each row. Raw values; formatting is the renderer's job. */
export interface RowContext {
  responsiveness: string | null;
  confidence: string | null;
  medianHoursResponse: number | null;
  noResponseRate: number | null;
  setupWeight: string | null;
  primaryLanguage: string | null;
  stars: number;
  /** cla | dco | both | none, or null for unmeasured. A cost to know about, not a score. */
  contributorAgreement: string | null;
  /** Facts that decay. Never scored — see `Candidate` for why. */
  current: CurrentState;
}

/**
 * The decaying facts, each carrying what makes it readable.
 *
 * Every field here is paired with an age or a denominator, because a claim verdict without a date and a
 * queue depth without the oldest entry are both the kind of number that looks authoritative and says
 * nothing.
 */
export interface CurrentState {
  /** Days since anything happened on the issue. Null when the timestamp is missing. */
  quietDays: number | null;
  /** Every open pull request in the repository. */
  openPrTotal: number | null;
  /** How long the oldest open pull request has waited, in days. */
  oldestOpenPrDays: number | null;
  /**
   * free | claimed | contested | in-progress | stale-claim, or null for NEVER CHECKED.
   *
   * Null is emphatically not `free`. An unchecked issue is unknown, and presenting it as available is
   * exactly the error that makes someone spend an evening on work already in flight.
   */
  claimVerdict: string | null;
  /** How long ago the check was made. A verdict from three weeks ago is nearly worthless. */
  claimAgeDays: number | null;
  claimants: number | null;
  /** Bounty labels, free from data already stored. */
  bounty: string[];
  /**
   * hype | rising | steady | cooling, or null when velocity could not be measured.
   *
   * Null is emphatically not `steady`. Velocity needs two samples a week or more apart, so a newly
   * discovered repository has none — and reporting that as "growing normally" would be an invention.
   */
  momentum: string | null;
  /** The verdict with the numbers that produced it, ready to display. */
  momentumDetail: string | null;
  /** Stars gained across the measured span, and how long that span was. */
  starsGained: number | null;
  velocitySpanDays: number | null;
}

function daysSince(iso: string | null, now: Date): number | null {
  if (iso === null) return null;
  const days = (now.getTime() - Date.parse(iso)) / 86_400_000;
  return Number.isFinite(days) ? Math.max(0, Math.round(days)) : null;
}

export function buildCurrentState(
  candidate: Candidate,
  now: Date,
  momentum?: RepoMomentum,
): CurrentState {
  return {
    momentum: momentum?.momentum.verdict ?? null,
    momentumDetail:
      momentum === undefined ? null : describeMomentum(momentum.momentum, momentum.velocity),
    starsGained: momentum?.velocity?.gained ?? null,
    velocitySpanDays: momentum?.velocity?.spanDays ?? null,
    quietDays: daysSince(candidate.updatedAtGh, now),
    openPrTotal: candidate.openPrTotal,
    oldestOpenPrDays: daysSince(candidate.oldestOpenPrAt, now),
    claimVerdict: candidate.claimVerdict,
    claimAgeDays: daysSince(candidate.claimCheckedAt, now),
    claimants: candidate.claimClaimants,
    bounty: bountyLabels(candidate.labels),
  };
}

export interface IssueRef {
  issueId: number;
  repoFullName: string;
  number: number;
  title: string;
  htmlUrl: string;
  labels: string[];
}

export interface ShortlistRow {
  rank: number;
  score: number;
  issue: IssueRef;
  /**
   * Issue-level lines only. Repo lines carry the largest weights, so including them made every row
   * show the same three project facts and say nothing about why one issue beat another.
   */
  evidence: ScoreLine[];
  /**
   * Where the score came from, over ALL lines rather than the four shown above.
   *
   * Repo weights dominate, so a row scoring 104 might be 82 project and 22 issue — meaning it is
   * really a recommendation of the repository. Without this a reader cannot tell that from a row
   * that earned its position on the issue's own merits, and the four displayed evidence lines are
   * capped and so cannot be summed to find out.
   */
  subtotals: { repo: number; issue: number };
  context: RowContext;
  /** Further scoring candidates in this repo that the per-repo cap held back. */
  heldBackInRepo: number;
  /**
   * Your own history with this project: declined and unlanded counts, and a repeated reason.
   *
   * Null when there is nothing worth saying. Displayed, never scored — see `patterns.ts` for why.
   */
  pattern: RepoPattern | null;
}

/**
 * Conditions worth surfacing that are not errors. Structured rather than pre-worded: the CLI's
 * remedy is a flag and the UI's is a control, so each renderer writes its own prose.
 */
export type ShortlistNotice =
  | { kind: 'no-candidates' }
  | { kind: 'none-scoring'; considered: number; minScore: number }
  | { kind: 'fetch-cap-hit'; fetchLimit: number };

export interface ShortlistSummary {
  /** Open, unassigned, unjudged issues that passed the SQL gates. */
  considered: number;
  /** Of those, how many met the score threshold. */
  scoring: number;
  shown: number;
  /**
   * Rows available after the cap, across all pages.
   *
   * Distinct from `scoring`: the cap holds candidates back, so a corpus with 400 scoring issues
   * concentrated in 30 repos offers 60 pageable rows at a cap of two, not 400. Paging over `scoring`
   * would run off the end of the list.
   */
  total: number;
  offset: number;
  repos: number;
  minScore: number;
  perRepo: number;
  limit: number;
  /** Over the scoring set, not the shown set. Null when nothing scored. */
  scoreRange: { min: number; max: number; median: number } | null;
}

export interface ShortlistView {
  summary: ShortlistSummary;
  rows: ShortlistRow[];
  notices: ShortlistNotice[];
}

/**
 * Ranks, caps, and summarises a candidate set.
 *
 * Takes the candidates rather than fetching them so it can be exercised against fixtures.
 */
export function assembleShortlist(
  candidates: Candidate[],
  options: ShortlistViewOptions = {},
): ShortlistView {
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const perRepo = options.perRepo ?? DEFAULT_PER_REPO;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const offset = Math.max(0, options.offset ?? 0);
  const fetchLimit = options.fetchLimit ?? DEFAULT_FETCH_LIMIT;

  const empty = (notices: ShortlistNotice[]): ShortlistView => ({
    summary: {
      considered: candidates.length,
      scoring: 0,
      shown: 0,
      total: 0,
      offset,
      repos: 0,
      minScore,
      perRepo,
      limit,
      scoreRange: null,
    },
    rows: [],
    notices,
  });

  if (candidates.length === 0) return empty([{ kind: 'no-candidates' }]);

  const notices: ShortlistNotice[] = [];
  // Reaching the cap means the ranking saw an arbitrary slice — whichever rows were most recently
  // updated — not the corpus. That has silently mis-ranked a run before.
  if (candidates.length >= fetchLimit) notices.push({ kind: 'fetch-cap-hit', fetchLimit });

  // The clock is threaded through rather than defaulted inside rankCandidates: issue age and the
  // issue-mill window are both relative to it, so a fixture cannot be scored reproducibly without it.
  // Current-state ages need the same clock, for the same reason.
  const now = options.now ?? new Date();
  const ranked = rankCandidates(candidates, {
    minScore,
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.profile !== undefined ? { profile: options.profile } : {}),
  });
  if (ranked.length === 0) {
    return empty([...notices, { kind: 'none-scoring', considered: candidates.length, minScore }]);
  }

  // Applied after ranking rather than in SQL, because momentum lives in a different table and is
  // computed rather than stored. A row whose velocity is UNMEASURED is excluded by any momentum filter:
  // asking for `rising` and being shown projects whose growth nobody has measured would answer a
  // different question.
  const momentumFilter = options.momentumFilter;

  const keptPerRepo = new Map<string, number>();
  const heldPerRepo = new Map<string, number>();
  const kept: ShortlistRow[] = [];

  // The whole ranked list is walked, not just the first page. Stopping at the limit made
  // `heldBackInRepo` a count of "held back so far", which is not what it claims, and it left no way
  // to know how many pages exist.
  for (const scored of ranked) {
    if (momentumFilter !== undefined) {
      const verdict = options.momentum?.get(scored.candidate.repoFullName)?.momentum.verdict ?? null;
      if (verdict !== momentumFilter) continue;
    }
    const repo = scored.candidate.repoFullName;
    const already = keptPerRepo.get(repo) ?? 0;
    if (already >= perRepo) {
      heldPerRepo.set(repo, (heldPerRepo.get(repo) ?? 0) + 1);
      continue;
    }
    keptPerRepo.set(repo, already + 1);

    const { candidate } = scored;
    kept.push({
      rank: 0,
      score: scored.score,
      issue: {
        issueId: candidate.issueId,
        repoFullName: candidate.repoFullName,
        number: candidate.number,
        title: candidate.title,
        htmlUrl: candidate.htmlUrl,
        labels: candidate.labels,
      },
      evidence: distinguishingLines(scored),
      subtotals: subtotalsOf(scored.lines),
      context: {
        responsiveness: candidate.responsiveness,
        confidence: candidate.confidence,
        medianHoursResponse: candidate.medianHoursResponse,
        noResponseRate: candidate.noResponseRate,
        setupWeight: candidate.setupWeight,
        primaryLanguage: candidate.primaryLanguage,
        stars: candidate.stars,
        contributorAgreement: candidate.contributorAgreement,
        current: buildCurrentState(candidate, now, options.momentum?.get(candidate.repoFullName)),
      },
      // Filled in below: the walk has not finished counting what it holds back.
      heldBackInRepo: 0,
      pattern: options.patterns?.get(candidate.repoFullName) ?? null,
    });
  }

  for (const row of kept) {
    row.heldBackInRepo = heldPerRepo.get(row.issue.repoFullName) ?? 0;
  }

  // Ranks are absolute positions in the capped list, so row 21 is "21" on page two rather than "1".
  kept.forEach((row, index) => {
    row.rank = index + 1;
  });

  const rows = kept.slice(offset, offset + limit);

  const scores = ranked.map((scored) => scored.score);
  return {
    summary: {
      considered: candidates.length,
      scoring: ranked.length,
      shown: rows.length,
      total: kept.length,
      offset,
      // Repos on this page, not in the whole capped list: it describes what is in front of you.
      repos: new Set(rows.map((row) => row.issue.repoFullName)).size,
      minScore,
      perRepo,
      limit,
      scoreRange: {
        min: Math.min(...scores),
        max: Math.max(...scores),
        median: median(scores),
      },
    },
    rows,
    notices,
  };
}

/** Split over every line, not the displayed subset. */
function subtotalsOf(lines: ScoreLine[]): { repo: number; issue: number } {
  let repo = 0;
  let issue = 0;
  for (const line of lines) {
    if (line.about === 'repo') repo += line.points;
    else issue += line.points;
  }
  return { repo, issue };
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

// ---------------------------------------------------------------------------
// why
// ---------------------------------------------------------------------------

export interface WhyView {
  issue: IssueRef;
  score: number;
  /** Sorted by points descending. Two separate questions: good project, and good issue within it. */
  repoLines: ScoreLine[];
  issueLines: ScoreLine[];
  repoSubtotal: number;
  issueSubtotal: number;
  /** Signals that could not contribute because the underlying data is missing. */
  unmeasured: string[];
  /** Your own history with this project. Null when there is nothing worth saying. */
  pattern: RepoPattern | null;
}

/** The itemised breakdown for one candidate, split the way the two questions divide. */
export function buildWhyView(
  candidate: Candidate,
  context?: RepoContext,
  now = new Date(),
  profile?: ResolvedProfile,
  pattern: RepoPattern | null = null,
): WhyView {
  // The same set the shortlist used, or the breakdown would not add up to the score it explains.
  const scored = scoreCandidate(candidate, now, context, profile, resolveWeights(profile?.weightSet));
  const byPoints = (a: ScoreLine, b: ScoreLine): number => b.points - a.points;
  const repoLines = scored.lines.filter((line) => line.about === 'repo').sort(byPoints);
  const issueLines = scored.lines.filter((line) => line.about === 'issue').sort(byPoints);
  const subtotals = subtotalsOf(scored.lines);

  return {
    issue: {
      issueId: candidate.issueId,
      repoFullName: candidate.repoFullName,
      number: candidate.number,
      title: candidate.title,
      htmlUrl: candidate.htmlUrl,
      labels: candidate.labels,
    },
    score: scored.score,
    repoLines,
    issueLines,
    repoSubtotal: subtotals.repo,
    issueSubtotal: subtotals.issue,
    unmeasured: scored.unmeasured,
    pattern,
  };
}

/** Re-exported so callers that only need the context builder do not reach into score.ts. */
export { buildRepoContext };

// ---------------------------------------------------------------------------
// decisions journal
// ---------------------------------------------------------------------------

export const VERDICTS = [
  'shortlisted',
  'rejected',
  'started',
  'abandoned',
  'submitted',
  'merged',
  'closed_unmerged',
  'stalled',
] as const;

export type Verdict = (typeof VERDICTS)[number];

export function isVerdict(value: string): value is Verdict {
  return (VERDICTS as readonly string[]).includes(value);
}

/** owner/name#123 */
export function parseIssueRef(ref: string): { fullName: string; number: number } {
  const match = /^([^#\s]+\/[^#\s]+)#(\d+)$/.exec(ref.trim());
  if (!match) {
    throw new Error(`Expected owner/name#123, got "${ref}"`);
  }
  return { fullName: match[1]!, number: Number.parseInt(match[2]!, 10) };
}

export interface JournalEntry {
  repoFullName: string;
  number: number;
  title: string;
  /** Verdicts in the order they were recorded. */
  trail: Verdict[];
  latestVerdict: Verdict;
  predictedHours: number | null;
  actualHours: number | null;
  /** actual / predicted, only when both exist. */
  ratio: number | null;
  reason: string | null;
  lastAt: string;
}

/**
 * How many complete prediction/outcome pairs before an average is worth printing.
 *
 * The whole project refuses to state precision it does not have, and a mean over one or two ratios
 * is exactly that. The threshold lives here, in the tested layer, so no renderer can decide to show
 * the number early.
 */
export const MIN_PAIRS_FOR_MEAN = 3;

export interface JournalView {
  entries: JournalEntry[];
  /** Entries with both a prediction and an outcome. */
  complete: number;
  /** Mean of actual/predicted. Null below MIN_PAIRS_FOR_MEAN, whatever the individual ratios say. */
  meanRatio: number | null;
}

/**
 * Aggregated per ISSUE, not per row.
 *
 * Verdicts arrive as separate rows over time — `started --hours 4`, then later
 * `merged --actual-hours 9` — so a per-row view could never pair a prediction with its outcome and
 * the accuracy line never appeared. The grouping happens in SQL; this computes what follows from it.
 */
export function summariseJournal(entries: JournalEntry[]): JournalView {
  const complete = entries.filter((entry) => entry.ratio !== null);
  return {
    entries,
    complete: complete.length,
    meanRatio:
      complete.length >= MIN_PAIRS_FOR_MEAN
        ? complete.reduce((sum, entry) => sum + entry.ratio!, 0) / complete.length
        : null,
  };
}

/**
 * Pairs a prediction with an outcome.
 *
 * Guards against a zero prediction, which would otherwise produce Infinity and render as an
 * authoritative-looking "Infinityx your prediction".
 */
export function hoursRatio(
  predictedHours: number | null,
  actualHours: number | null,
): number | null {
  if (predictedHours === null || actualHours === null || predictedHours <= 0) return null;
  return actualHours / predictedHours;
}
