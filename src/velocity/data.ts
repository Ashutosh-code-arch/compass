/**
 * Reading star history. No judgement: the query picks the two endpoints of the window and counts the
 * samples between them, and `compute.ts` decides what they mean.
 *
 * Endpoints rather than every row on purpose. A ninety-day window over a thousand repositories is tens
 * of thousands of rows fetched to use two of them per repository, and this project has already paid once
 * for a query that scaled with the corpus rather than with the answer — `why` took 2,600ms until it was
 * scoped. Aggregating here keeps velocity at one small row per repository.
 */

import { db } from '../db.ts';
import { assessMomentum, velocityBetween, DEFAULT_WINDOW_DAYS } from './compute.ts';
import type { RepoMomentum } from './types.ts';

interface EndpointRow {
  full_name: string;
  oldest_at: Date;
  newest_at: Date;
  oldest_stars: number;
  newest_stars: number;
  samples: number;
  created_at_gh: Date | null;
  responsiveness: string | null;
  merge_rate: string | null;
  merged_prs: number | null;
  closed_unmerged_prs: number | null;
  open_pr_total: number | null;
}

export interface MomentumOptions {
  windowDays?: number;
  /** One repository, for `why` and any other single-row path. */
  repoFullName?: string;
  now?: Date;
}

/**
 * Momentum per repository, keyed by full name.
 *
 * Only repositories with at least two samples in the window appear. An absent key means velocity is
 * unmeasured, which callers must render as absent rather than as "not growing" — the distinction is the
 * reason Phase 0 waited months before this function could exist at all.
 */
export async function getRepoMomentum(
  options: MomentumOptions = {},
): Promise<Map<string, RepoMomentum>> {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = options.now ?? new Date();

  const rows = (
    await db().query<EndpointRow>(
      `select r.full_name,
              min(h.observed_at)                                        as oldest_at,
              max(h.observed_at)                                        as newest_at,
              (array_agg(h.stars order by h.observed_at asc))[1]        as oldest_stars,
              (array_agg(h.stars order by h.observed_at desc))[1]       as newest_stars,
              count(*)::int                                             as samples,
              r.created_at_gh,
              m.responsiveness,
              m.merge_rate,
              m.merged_prs,
              m.closed_unmerged_prs,
              m.open_pr_total
         from repo_stars_history h
         join repos r on r.id = h.repo_id
         left join repo_metrics m on m.repo_id = r.id
        where h.observed_at >= now() - make_interval(days => $1::int)
          and ($2::text is null or r.full_name = $2)
        group by r.full_name, r.created_at_gh, m.responsiveness, m.merge_rate,
                 m.merged_prs, m.closed_unmerged_prs, m.open_pr_total
       having count(*) >= 2`,
      [windowDays, options.repoFullName ?? null],
    )
  ).rows;

  const out = new Map<string, RepoMomentum>();
  for (const row of rows) {
    const velocity = velocityBetween(
      { observedAt: row.oldest_at.toISOString(), stars: row.oldest_stars },
      { observedAt: row.newest_at.toISOString(), stars: row.newest_stars },
      row.samples,
    );

    const decided = (row.merged_prs ?? 0) + (row.closed_unmerged_prs ?? 0);
    const momentum = assessMomentum({
      velocity,
      ageDays:
        row.created_at_gh === null
          ? null
          : Math.round((now.getTime() - row.created_at_gh.getTime()) / 86_400_000),
      responsiveness: row.responsiveness,
      mergeRate: row.merge_rate === null ? null : Number(row.merge_rate),
      decidedPrs: decided,
      openPrTotal: row.open_pr_total,
    });

    out.set(row.full_name, { repoFullName: row.full_name, velocity, momentum });
  }
  return out;
}
