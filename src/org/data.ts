/**
 * Queries feeding the organisation view. No formatting, no judgement — every combining decision lives
 * in `view.ts` where a fixture can reach it.
 *
 * One query returns one row per (organisation, repository) and the rollup happens in memory. A
 * thousand repositories is nothing to aggregate in TypeScript, and the alternative — a query full of
 * `mode() within group` and pooled ratios — would put four judgements somewhere no test can see them.
 */

import { db } from '../db.ts';
import { CANDIDATE_GATES } from '../rank/candidates.ts';
import { getRepoMomentum } from '../velocity/data.ts';
import { assembleOrgs, type AssembleOrgsOptions, type OrgRepoRow, type OrgsView, type OrgTagRow } from './view.ts';

interface OrgRepoDbRow {
  login: string;
  display_name: string | null;
  repo_full_name: string | null;
  primary_language: string | null;
  stars: number | null;
  responsiveness: string | null;
  confidence: string | null;
  median_hours_response: string | null;
  no_response_rate: string | null;
  merged_prs: number | null;
  closed_unmerged_prs: number | null;
  setup_weight: string | null;
  contributor_agreement: string | null;
  candidates: number;
}

/**
 * One row per repository, with its organisation attached.
 *
 * Starts from `organizations` rather than from `repos`, which is what keeps an organisation with no
 * repositories in the corpus — a GSoC import that has never been measured — in the result set as a
 * single row with nulls. That row is not noise to be filtered; it is the answer to "which of these
 * have I never looked at".
 *
 * `sync_state <> 'gone'` rather than `= 'active'`: a paused repository is still part of the
 * organisation and should be counted, it just cannot contribute candidates — and the shared gates
 * already enforce that, so the two counts differ for a reason the reader can name.
 */
export async function fetchOrgRepos(): Promise<OrgRepoRow[]> {
  // Momentum is computed from star history rather than stored, so it is fetched alongside and attached
  // by full name. One extra small query for the whole corpus.
  const momentum = await getRepoMomentum();

  const rows = (
    await db().query<OrgRepoDbRow>(
      `with candidate_counts as (
         select i.repo_id, count(*)::int as n
           from issues i
           join repos r on r.id = i.repo_id
          where ${CANDIDATE_GATES}
          group by i.repo_id
       )
       select o.login,
              o.display_name,
              ro.full_name              as repo_full_name,
              ro.primary_language,
              ro.stars,
              m.responsiveness,
              m.confidence,
              m.median_hours_response,
              m.no_response_rate,
              m.merged_prs,
              m.closed_unmerged_prs,
              f.setup_weight,
              f.contributor_agreement,
              coalesce(c.n, 0)          as candidates
         from organizations o
         left join repos ro
                on ro.owner = o.login
               and ro.sync_state <> 'gone'
         left join repo_metrics    m on m.repo_id = ro.id
         left join setup_facts     f on f.repo_id = ro.id
         left join candidate_counts c on c.repo_id = ro.id
        order by o.login, ro.stars desc nulls last`,
    )
  ).rows;

  return rows.map((row) => ({
    login: row.login,
    displayName: row.display_name,
    repoFullName: row.repo_full_name,
    primaryLanguage: row.primary_language,
    stars: row.stars,
    responsiveness: row.responsiveness,
    confidence: row.confidence,
    // numeric arrives as a string from pg. Null must survive as null all the way to the dash.
    medianHoursResponse: row.median_hours_response === null ? null : Number(row.median_hours_response),
    noResponseRate: row.no_response_rate === null ? null : Number(row.no_response_rate),
    mergedPrs: row.merged_prs,
    closedUnmergedPrs: row.closed_unmerged_prs,
    setupWeight: row.setup_weight,
    contributorAgreement: row.contributor_agreement,
    candidates: row.candidates,
    momentum:
      row.repo_full_name === null
        ? null
        : (momentum.get(row.repo_full_name)?.momentum.verdict ?? null),
    starsGained:
      row.repo_full_name === null
        ? null
        : (momentum.get(row.repo_full_name)?.velocity?.gained ?? null),
  }));
}

/** Every curated claim. Small enough to fetch whole; filtering happens in the pure layer. */
export async function fetchOrgTags(): Promise<OrgTagRow[]> {
  const rows = (
    await db().query<{
      org_login: string;
      kind: string;
      value: string;
      source: string | null;
      reviewed_at: Date;
    }>(
      `select org_login, kind, value, source, reviewed_at
         from org_tags
        order by org_login, kind, value`,
    )
  ).rows;

  return rows.map((row) => ({
    login: row.org_login,
    kind: row.kind,
    value: row.value,
    source: row.source,
    reviewedAt: row.reviewed_at.toISOString().slice(0, 10),
  }));
}

/** The organisation table: rolled up, filtered, sorted, paginated. */
export async function getOrgs(options: AssembleOrgsOptions = {}): Promise<OrgsView> {
  const [rows, tags] = await Promise.all([fetchOrgRepos(), fetchOrgTags()]);
  return assembleOrgs(rows, tags, options);
}
