import { resolveStackTerm } from '../setup/stack.ts';
import { db } from '../db.ts';
import type { Candidate } from './score.ts';

export interface ShortlistFilters {
  /** Repo primary language. */
  language?: string;
  /** Require one of the invited/beginner labels. */
  labelledOnly?: boolean;
  /** Include repos whose maintainers look dormant. Off by default: that is the point. */
  includeDormant?: boolean;
  /** Exclude repos above this setup weight. */
  maxSetupWeight?: string;
  minStars?: number;
  maxStars?: number;
  /**
   * Restrict to a single repository.
   *
   * Only `why` uses this. It needs the repository context, which `buildRepoContext` derives from the
   * candidate set — but that context is per-repo, so scanning the whole corpus to rebuild one repo's
   * entry is waste that scales with the corpus rather than with the answer.
   */
  repoFullName?: string;
  /**
   * Restrict to one organisation, matched against `repos.owner` case-insensitively.
   *
   * This is the drill-down the organisation table links to. Case-insensitive for the same reason
   * `--language` is: GitHub's casing is canonical but nobody types it that way, and an exact match
   * returning an empty shortlist looks exactly like a real answer.
   */
  org?: string;
  /**
   * Drop issues a claim check has shown to be taken.
   *
   * Only affects issues that have actually been checked; an unchecked issue is not evidence of
   * anything and stays in the list. `stale-claim` also stays, because a request nobody followed up on
   * for a fortnight is, in practice, an available issue again.
   */
  excludeClaimed?: boolean;
  /**
   * Safety cap on rows fetched before scoring. Rows are small — the issue body is reduced to a
   * length in SQL — so this is generous on purpose. At the old default of 4,000 a 60,000-issue
   * corpus was silently ranked on whichever slice happened to be most recently updated.
   */
  fetchLimit?: number;
  /** Rows to skip after ranking and capping. Ranking happens in memory, so this is not SQL OFFSET. */
  offset?: number;
  /**
   * What the project is built with: "react", "django", "js".
   *
   * Resolved by `resolveStackTerm` into detected frameworks and/or language names, then matched
   * against `setup_facts.frameworks`, `repos.topics` and `repos.primary_language`. Matching the
   * repository *name* is deliberately not part of it — a repo called `awesome-react-tips` is not a
   * React project, and that is the failure this filter exists to avoid.
   */
  stack?: string;
}

interface CandidateRow {
  issue_id: number;
  repo_full_name: string;
  number: number;
  title: string;
  labels: string[];
  comment_count: number;
  created_at_gh: Date;
  author_association: string | null;
  body_length: number;
  html_url: string;
  primary_language: string | null;
  topics: string[];
  stars: number;
  responsiveness: string | null;
  confidence: string | null;
  median_hours_response: string | null;
  no_response_rate: string | null;
  merge_rate: string | null;
  merged_prs: number | null;
  closed_unmerged_prs: number | null;
  setup_weight: string | null;
  compose_services: number | null;
  env_var_count: number | null;
  has_devcontainer: boolean | null;
  task_runner: string | null;
  has_contributing: boolean | null;
  ci_runs_on_pr: boolean | null;
  contributor_agreement: string | null;
  updated_at_gh: Date | null;
  open_pr_total: number | null;
  oldest_open_pr_at: Date | null;
  claim_verdict: string | null;
  claim_checked_at: Date | null;
  claim_claimants: number | null;
}

const WEIGHT_RANK: Record<string, number> = { light: 1, moderate: 2, heavy: 3, unknown: 4 };

/**
 * The unconditional hard gates, as a SQL fragment. Expects `issues i` joined to `repos r`.
 *
 * Shared rather than duplicated because the organisation rollup counts open candidates per
 * organisation, and if that count is computed from a second copy of these conditions the two drift
 * and the org screen quietly disagrees with the shortlist it links to. `candidates.test.ts` asserts
 * both queries reference this constant.
 *
 * What is deliberately NOT here: the dormant filter. The shortlist excludes dormant repositories
 * because no combination of good labels compensates for nobody reading your PR. The org table has the
 * opposite job — "this GSoC organisation has 40 open issues and has not replied to an outsider in 31
 * days" is the single most valuable row it can show, and hiding it would defeat the purpose. So that
 * gate stays parameterised at the shortlist's call site.
 */
export const CANDIDATE_GATES = `i.state = 'open'
          -- somebody else's work, not a weak candidate
          and i.assignee_logins = '{}'
          and not i.is_locked
          and r.sync_state = 'active'
          -- already judged: the journal is what keeps the shortlist from repeating itself
          and not exists (select 1 from decisions d where d.issue_id = i.id)`;

/**
 * Hard gates live in SQL; preferences live in the score.
 *
 * The distinction matters. An assigned issue is not a weak candidate, it is somebody else's work —
 * so it is excluded rather than penalised. Dormant repos are excluded for the same reason: no
 * combination of good labels and easy setup compensates for nobody reading your PR.
 */
export async function fetchCandidates(filters: ShortlistFilters = {}): Promise<Candidate[]> {
  // One term, two possible meanings. "react" is a framework, "js" is a pair of languages, and the
  // query needs both arrays regardless so the parameter positions stay fixed.
  const stack = filters.stack
    ? resolveStackTerm(filters.stack)
    : { stacks: [] as string[], languages: [] as string[] };
  const rows = (
    await db().query<CandidateRow>(
      `select i.id                        as issue_id,
              r.full_name                as repo_full_name,
              i.number,
              i.title,
              i.labels,
              i.comment_count,
              i.created_at_gh,
              i.author_association,
              coalesce(length(i.body), 0) as body_length,
              i.html_url,
              r.primary_language,
              r.stars,
              r.topics,
              m.responsiveness,
              m.confidence,
              m.median_hours_response,
              m.no_response_rate,
              m.merge_rate,
              m.merged_prs,
              m.closed_unmerged_prs,
              f.setup_weight,
              f.compose_services,
              f.env_var_count,
              f.has_devcontainer,
              f.task_runner,
              f.has_contributing,
              f.ci_runs_on_pr,
              f.contributor_agreement,
              i.updated_at_gh,
              m.open_pr_total,
              m.oldest_open_pr_at,
              -- Whatever is already known about claims. Costs nothing: this is a cache of checks you
              -- have already paid for, and it is what makes checking an issue worth doing more than
              -- once.
              cl.verdict     as claim_verdict,
              cl.checked_at  as claim_checked_at,
              cl.claimants   as claim_claimants
         from issues i
         join repos r on r.id = i.repo_id
         left join repo_metrics m on m.repo_id = i.repo_id
         left join setup_facts  f on f.repo_id = i.repo_id
         left join issue_claims cl on cl.issue_id = i.id
        where ${CANDIDATE_GATES}
          and ($1::boolean or coalesce(m.responsiveness, 'unknown') <> 'dormant')
          -- Case-insensitive: GitHub's casing is canonical ("TypeScript"), but nobody types it that
          -- way, and an exact match silently returned an empty shortlist for "typescript".
          and ($2::text is null or lower(r.primary_language) = lower($2))
          and ($3::int  is null or r.stars >= $3)
          and ($4::int  is null or r.stars <= $4)
          and ($5::int  is null
               or coalesce(($6::jsonb ->> coalesce(f.setup_weight, 'unknown'))::int, 4) <= $5)
          and (not $7::boolean or i.labels && $8::text[])
          and ($10::text is null or r.full_name = $10)
          and ($14::text is null or lower(r.owner) = lower($14))
          -- Excludes only what has been CHECKED and found taken. An unchecked issue stays in: it has
          -- not been shown to be free, and dropping it would quietly turn this into "only issues I
          -- have already spent a request on".
          and (not $15::boolean
               or cl.verdict is null
               or cl.verdict in ('free', 'stale-claim'))
          -- Stack: any of detected frameworks, declared topics, or primary language.
          --
          -- $13 says a stack was ASKED FOR, which is not the same as the resolved arrays being
          -- non-empty. Inferring it from emptiness made an unrecognised term ("quantum-blockchain")
          -- indistinguishable from no filter at all, so it returned the entire corpus — a filter that
          -- silently does not filter is worse than one that errors.
          and (not $13::boolean
               or coalesce(f.frameworks, '{}') && $11::text[]
               or coalesce(r.topics, '{}') && $11::text[]
               or lower(r.primary_language) = any($12::text[]))
        order by i.updated_at_gh desc
        limit $9`,
      [
        filters.includeDormant ?? false,
        filters.language ?? null,
        filters.minStars ?? null,
        filters.maxStars ?? null,
        filters.maxSetupWeight ? (WEIGHT_RANK[filters.maxSetupWeight] ?? null) : null,
        JSON.stringify(WEIGHT_RANK),
        filters.labelledOnly ?? false,
        INVITED_LABEL_VARIANTS,
        filters.fetchLimit ?? 50000,
        filters.repoFullName ?? null,
        stack.stacks,
        stack.languages.map((language) => language.toLowerCase()),
        filters.stack !== undefined && filters.stack !== '',
        filters.org ?? null,
        filters.excludeClaimed ?? false,
      ],
    )
  ).rows;

  return rows.map((row) => ({
    issueId: row.issue_id,
    repoFullName: row.repo_full_name,
    number: row.number,
    title: row.title,
    labels: row.labels,
    commentCount: row.comment_count,
    createdAtGh: row.created_at_gh.toISOString(),
    authorAssociation: row.author_association,
    bodyLength: row.body_length,
    htmlUrl: row.html_url,
    primaryLanguage: row.primary_language,
    topics: row.topics,
    stars: row.stars,
    responsiveness: row.responsiveness,
    confidence: row.confidence,
    medianHoursResponse: numeric(row.median_hours_response),
    noResponseRate: numeric(row.no_response_rate),
    mergeRate: numeric(row.merge_rate),
    mergedPrs: row.merged_prs,
    closedUnmergedPrs: row.closed_unmerged_prs,
    setupWeight: row.setup_weight,
    composeServices: row.compose_services,
    envVarCount: row.env_var_count,
    hasDevcontainer: row.has_devcontainer,
    taskRunner: row.task_runner,
    hasContributing: row.has_contributing,
    ciRunsOnPr: row.ci_runs_on_pr,
    contributorAgreement: row.contributor_agreement,
    updatedAtGh: row.updated_at_gh === null ? null : row.updated_at_gh.toISOString(),
    openPrTotal: row.open_pr_total,
    oldestOpenPrAt: row.oldest_open_pr_at === null ? null : row.oldest_open_pr_at.toISOString(),
    claimVerdict: row.claim_verdict,
    claimCheckedAt: row.claim_checked_at === null ? null : row.claim_checked_at.toISOString(),
    claimClaimants: row.claim_claimants,
  }));
}

/** pg returns numeric as string to avoid precision loss; null must survive as null. */
function numeric(value: string | null): number | null {
  return value === null ? null : Number(value);
}

/**
 * Exact label strings for the `--labelled` gate. Kept exact rather than fuzzy because this is a
 * hard filter — the score does the fuzzy matching.
 */
const INVITED_LABEL_VARIANTS = [
  'good first issue',
  'good-first-issue',
  'help wanted',
  'help-wanted',
  'up-for-grabs',
  'beginner friendly',
  'E-easy',
];
