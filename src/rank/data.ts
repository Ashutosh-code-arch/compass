/**
 * Data access for the ranking commands: query Postgres, hand back the presentation models from
 * `view.ts`. No formatting, no console.
 *
 * Everything a renderer needs comes back in the returned value, including the cases that used to be
 * an early `console.log` and a bare `return` — an empty candidate set is a result, not an error.
 */

import { db } from '../db.ts';
import {
  EMPTY_PROFILE,
  resolveProfile,
  type Profile,
  type SetupWeight,
} from './profile.ts';
import { fetchCandidates, type ShortlistFilters } from './candidates.ts';
import { getRepoMomentum } from '../velocity/data.ts';
import { buildRepoPatterns, type DecidedIssue, type RepoPattern } from './patterns.ts';
import type { Candidate, RepoContext } from './score.ts';
import {
  assembleShortlist,
  buildRepoContext,
  buildWhyView,
  DEFAULT_FETCH_LIMIT,
  hoursRatio,
  isVerdict,
  parseIssueRef,
  summariseJournal,
  VERDICTS,
  type JournalEntry,
  type JournalView,
  type ShortlistView,
  type Verdict,
  type WhyView,
} from './view.ts';

export interface ShortlistOptions extends ShortlistFilters {
  limit?: number;
  offset?: number;
  minScore?: number;
  perRepo?: number;
  /** hype | rising | steady | cooling. Excludes repositories whose velocity is unmeasured. */
  momentum?: string;
  /**
   * Score against a named weight set for this run only, without changing the saved profile.
   *
   * Exists because trying a different set is the natural way to find out whether you want it, and
   * editing settings to answer that question then editing them back is how people end up with a profile
   * they did not choose.
   */
  weightSet?: string;
}

export interface LanguageCount {
  language: string;
  repos: number;
}

/**
 * The languages actually present, with GitHub's canonical casing.
 *
 * Exists so the UI can offer a list instead of a free-text box. Typing a language was the only place
 * in the interface where getting the casing wrong returned an empty result that looked like a real
 * answer, and a picker removes the failure rather than tolerating it.
 */
export async function getLanguages(): Promise<LanguageCount[]> {
  return (
    await db().query<{ language: string; repos: string }>(
      `select r.primary_language as language, count(*)::text as repos
         from repos r
        where r.primary_language is not null
          -- Paused repos are excluded from the shortlist, so offering their languages would produce
          -- a picker entry that always yields nothing.
          and r.sync_state = 'active'
        group by r.primary_language
        order by count(*) desc, r.primary_language asc`,
    )
  ).rows.map((row) => ({ language: row.language, repos: Number(row.repos) }));
}

export interface StackCount {
  stack: string;
  repos: number;
}

/**
 * Frameworks actually detected in the corpus, most common first.
 *
 * Same purpose as getLanguages: the UI offers a list rather than a text box, so "React" cannot be
 * mistyped into an empty result that looks like a real answer.
 */
export async function getStacks(): Promise<StackCount[]> {
  return (
    await db().query<{ stack: string; repos: string }>(
      `select unnest(f.frameworks) as stack, count(*)::text as repos
         from setup_facts f
         join repos r on r.id = f.repo_id
        where r.sync_state = 'active'
        group by 1
        order by count(*) desc, 1 asc`,
    )
  ).rows.map((row) => ({ stack: row.stack, repos: Number(row.repos) }));
}

interface ProfileRow {
  language_points: Record<string, number>;
  topic_points: Record<string, number>;
  avoid_topics: string[];
  avoid_labels: string[];
  min_stars: number | null;
  max_stars: number | null;
  max_setup_weight: string | null;
  weight_set: string | null;
}

/**
 * The single profile row. Migration 007 inserts it, so this does not have to handle absence — but it
 * does anyway, because a database restored from before 007 would otherwise fail every request rather
 * than falling back to the defaults it used to use.
 */
export async function getProfile(): Promise<Profile> {
  const rows = (
    await db().query<ProfileRow>(
      `select language_points, topic_points, avoid_topics, avoid_labels,
              min_stars, max_stars, max_setup_weight, weight_set
         from profile where id = 1`,
    )
  ).rows;
  const row = rows[0];
  if (!row) return EMPTY_PROFILE;
  return {
    languagePoints: row.language_points,
    topicPoints: row.topic_points,
    avoidTopics: row.avoid_topics,
    avoidLabels: row.avoid_labels,
    minStars: row.min_stars,
    maxStars: row.max_stars,
    maxSetupWeight: (row.max_setup_weight as SetupWeight | null) ?? null,
    weightSet: (row.weight_set as Profile['weightSet']) ?? null,
  };
}

/** Whole-row replace rather than a patch: the settings screen always sends the complete profile. */
export async function saveProfile(profile: Profile): Promise<Profile> {
  await db().query(
    `insert into profile (id, language_points, topic_points, avoid_topics, avoid_labels,
                          min_stars, max_stars, max_setup_weight, weight_set, updated_at)
     values (1, $1, $2, $3, $4, $5, $6, $7, $8, now())
     on conflict (id) do update set
       language_points  = excluded.language_points,
       topic_points     = excluded.topic_points,
       avoid_topics     = excluded.avoid_topics,
       avoid_labels     = excluded.avoid_labels,
       min_stars        = excluded.min_stars,
       max_stars        = excluded.max_stars,
       max_setup_weight = excluded.max_setup_weight,
       weight_set       = excluded.weight_set,
       updated_at       = now()`,
    [
      JSON.stringify(profile.languagePoints),
      JSON.stringify(profile.topicPoints),
      profile.avoidTopics,
      profile.avoidLabels,
      profile.minStars,
      profile.maxStars,
      profile.maxSetupWeight,
      profile.weightSet,
    ],
  );
  return getProfile();
}

/**
 * The profile supplies defaults for the star band and setup ceiling; an explicit request wins.
 *
 * The distinction matters for a UI that wants to widen the band for one look without editing the
 * saved preference, which is the common case when a shortlist comes back thin.
 */
function withProfileDefaults(options: ShortlistOptions, profile: Profile): ShortlistOptions {
  return {
    ...options,
    ...(options.minStars === undefined && profile.minStars !== null
      ? { minStars: profile.minStars }
      : {}),
    ...(options.maxStars === undefined && profile.maxStars !== null
      ? { maxStars: profile.maxStars }
      : {}),
    ...(options.maxSetupWeight === undefined && profile.maxSetupWeight !== null
      ? { maxSetupWeight: profile.maxSetupWeight }
      : {}),
  };
}

/**
 * The journal reduced to one row per issue: its latest verdict and its latest written reason.
 *
 * Grouped per issue in SQL for the same reason `getJournal` is: verdicts arrive as separate rows over
 * time, so `started` followed by `abandoned` is one abandonment and counting rows would call it two.
 *
 * Scoped to one repository when asked. `why` needs this for a single project, and the whole-corpus
 * version of the query is the shape of mistake that made expanding one row cost as much as the entire
 * ranking.
 */
export async function getRepoPatterns(repoFullName?: string): Promise<Map<string, RepoPattern>> {
  const rows = (
    await db().query<{ full_name: string; latest_verdict: string; reason: string | null }>(
      `select r.full_name,
              (array_agg(d.verdict order by d.created_at desc))[1]  as latest_verdict,
              (array_agg(d.reason order by d.created_at desc)
                 filter (where d.reason is not null))[1]            as reason
         from decisions d
         join issues i on i.id = d.issue_id
         join repos r on r.id = i.repo_id
        where ($1::text is null or r.full_name = $1)
        group by r.full_name, i.id
        -- Most recent first, so the newest wording of a repeated reason is the one kept.
        order by max(d.created_at) desc`,
      [repoFullName ?? null],
    )
  ).rows;

  const decided: DecidedIssue[] = rows.map((row) => ({
    repoFullName: row.full_name,
    latestVerdict: row.latest_verdict,
    reason: row.reason,
  }));
  return buildRepoPatterns(decided);
}

/** The ranked list, with the evidence for each row. */
export async function getShortlist(options: ShortlistOptions = {}): Promise<ShortlistView> {
  const stored = await getProfile();
  const profile: Profile =
    options.weightSet === undefined
      ? stored
      : { ...stored, weightSet: options.weightSet as Profile['weightSet'] };
  const filters = withProfileDefaults(options, profile);
  const [candidates, patterns, momentum] = await Promise.all([
    fetchCandidates(filters),
    getRepoPatterns(),
    getRepoMomentum(),
  ]);
  return assembleShortlist(candidates, {
    profile: resolveProfile(profile),
    patterns,
    momentum,
    ...(options.momentum === undefined ? {} : { momentumFilter: options.momentum }),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.offset !== undefined ? { offset: options.offset } : {}),
    ...(options.minScore !== undefined ? { minScore: options.minScore } : {}),
    ...(options.perRepo !== undefined ? { perRepo: options.perRepo } : {}),
    fetchLimit: options.fetchLimit ?? DEFAULT_FETCH_LIMIT,
  });
}

/**
 * Loads one candidate along with the repository context derived from the whole candidate set.
 *
 * Two deliberate choices. The gates are dropped, because `why` has to work on a row the shortlist
 * rejected — that is most of what it is for. And the context comes from the full set, because an
 * issue mill's individual issues each look excellent; the pattern only exists across issues.
 */
async function loadOne(
  ref: string,
): Promise<{ candidate: Candidate; context: RepoContext | undefined } | null> {
  const { fullName, number } = parseIssueRef(ref);
  // Scoped to the one repository. The context this builds is per-repo, so the rest of the corpus
  // cannot change the answer — and scanning it made expanding a row cost as much as the whole
  // ranking. Gates stay off: `why` must work on a row the shortlist rejected, which is most of the
  // reason to open it.
  const candidates = await fetchCandidates({
    fetchLimit: 100000,
    includeDormant: true,
    repoFullName: fullName,
  });
  const candidate = candidates.find(
    (entry) => entry.repoFullName === fullName && entry.number === number,
  );
  if (!candidate) return null;
  return { candidate, context: buildRepoContext(candidates).get(candidate.repoFullName) };
}

/** Itemised breakdown for a single issue. Null when the issue is not a current candidate. */
export async function getWhy(ref: string): Promise<WhyView | null> {
  const { fullName } = parseIssueRef(ref);
  // Scoped to one repository, like the patterns query. The whole-corpus version of this is the shape of
  // mistake that made expanding one row cost as much as the entire ranking.
  const [loaded, profile, patterns, momentum] = await Promise.all([
    loadOne(ref),
    getProfile(),
    getRepoPatterns(fullName),
    getRepoMomentum({ repoFullName: fullName }),
  ]);
  if (!loaded) return null;
  return buildWhyView(
    loaded.candidate,
    loaded.context,
    new Date(),
    resolveProfile(profile),
    patterns.get(loaded.candidate.repoFullName) ?? null,
  );
}

export interface DecideOptions {
  predictedHours?: number;
  actualHours?: number;
  reason?: string;
}

export interface DecisionRecord {
  repoFullName: string;
  number: number;
  title: string;
  verdict: Verdict;
  predictedHours: number | null;
  actualHours: number | null;
  reason: string | null;
}

/**
 * Records a judgement and thereby removes the issue from future shortlists.
 *
 * This is Slice 5's journal, and it is what eventually makes the weights in weights.ts defensible:
 * predicted hours against actual, and which signals were present when you were right or wrong.
 * Nothing infers from it yet.
 */
export async function recordDecision(
  ref: string,
  verdict: string,
  options: DecideOptions = {},
): Promise<DecisionRecord> {
  if (!isVerdict(verdict)) {
    throw new Error(`Unknown verdict "${verdict}". One of: ${VERDICTS.join(', ')}`);
  }
  const { fullName, number } = parseIssueRef(ref);

  const found = await db().query<{ id: number; title: string }>(
    `select i.id, i.title from issues i join repos r on r.id = i.repo_id
      where r.full_name = $1 and i.number = $2`,
    [fullName, number],
  );
  const issue = found.rows[0];
  if (!issue) {
    throw new Error(`${ref} is not in the corpus. Sync its repo first, or check the number.`);
  }

  const predictedHours = options.predictedHours ?? null;
  const actualHours = options.actualHours ?? null;
  const reason = options.reason ?? null;

  await db().query(
    `insert into decisions (issue_id, verdict, predicted_hours, actual_hours, reason)
     values ($1, $2, $3, $4, $5)`,
    [issue.id, verdict, predictedHours, actualHours, reason],
  );

  return {
    repoFullName: fullName,
    number,
    title: issue.title,
    verdict,
    predictedHours,
    actualHours,
    reason,
  };
}

interface JournalRow {
  full_name: string;
  number: number;
  title: string;
  trail: string;
  latest_verdict: string;
  predicted_hours: string | null;
  actual_hours: string | null;
  reason: string | null;
  last_at: Date;
}

/** Prediction against outcome, which is the only honest basis for retuning the weights. */
export async function getJournal(limit = 30): Promise<JournalView> {
  const rows = (
    await db().query<JournalRow>(
      `select r.full_name,
              i.number,
              i.title,
              string_agg(d.verdict, ' -> ' order by d.created_at)              as trail,
              (array_agg(d.verdict order by d.created_at desc))[1]             as latest_verdict,
              max(d.predicted_hours)                                           as predicted_hours,
              max(d.actual_hours)                                             as actual_hours,
              (array_agg(d.reason order by d.created_at desc)
                 filter (where d.reason is not null))[1]                       as reason,
              max(d.created_at)                                                as last_at
         from decisions d
         join issues i on i.id = d.issue_id
         join repos r on r.id = i.repo_id
        group by r.full_name, i.number, i.title
        order by max(d.created_at) desc
        limit $1`,
      [limit],
    )
  ).rows;

  return summariseJournal(rows.map(toJournalEntry));
}

/** pg returns numeric as string to avoid precision loss; null must survive as null. */
function numeric(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function toJournalEntry(row: JournalRow): JournalEntry {
  const predictedHours = numeric(row.predicted_hours);
  const actualHours = numeric(row.actual_hours);
  return {
    repoFullName: row.full_name,
    number: row.number,
    title: row.title,
    trail: row.trail.split(' -> ').filter(isVerdict),
    latestVerdict: isVerdict(row.latest_verdict) ? row.latest_verdict : 'shortlisted',
    predictedHours,
    actualHours,
    ratio: hoursRatio(predictedHours, actualHours),
    reason: row.reason,
    lastAt: row.last_at.toISOString(),
  };
}
