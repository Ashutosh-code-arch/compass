import { bulkUpsert, db } from '../db.ts';
import { mapLimit } from '../github/rest.ts';
import type { GhRepo } from '../github/types.ts';
import { mapRepoRow, REPO_COLUMNS, REPO_UPDATE_COLUMNS } from './map.ts';
import { refreshOrganizations } from './orgs.ts';
import { recordStars, type StarSample } from './stars.ts';
import { withSyncRun, type RunContext, type RunSummary } from './run.ts';

export interface SyncReposOptions {
  /** Skip repos whose metadata was refreshed within this window. */
  staleHours?: number;
  limit?: number;
  /** "owner/name" to refresh a single repo regardless of staleness. */
  repo?: string;
}

interface RepoTarget {
  id: number;
  full_name: string;
  discovered_via: string;
  meta_etag: string | null;
  /** The last reading, which a 304 confirms is still current. */
  stars: number;
}

/**
 * Refreshes repos from /repos/{owner}/{name}, which has a stable URL — so a stored ETag turns
 * unchanged repos into 304s that cost no quota at all. Stars move often enough that plenty will
 * still return 200, but the archived/abandoned tail of the corpus becomes free to keep current.
 */
export async function syncRepos(options: SyncReposOptions = {}): Promise<RunSummary> {
  const staleHours = options.staleHours ?? 24;
  const pool = db();

  const targets = options.repo
    ? (
        await pool.query<RepoTarget>(
          `select id, full_name, discovered_via, meta_etag, stars
             from repos where full_name = $1`,
          [options.repo],
        )
      ).rows
    : (
        await pool.query<RepoTarget>(
          `select id, full_name, discovered_via, meta_etag, stars
             from repos
            where sync_state = 'active'
              and (meta_synced_at is null
                   or meta_synced_at < now() - make_interval(hours => $1::int))
            order by meta_synced_at nulls first, stars desc
            limit $2`,
          [staleHours, options.limit ?? 1000],
        )
      ).rows;

  if (targets.length === 0) {
    console.log(`Nothing to refresh (all metadata newer than ${staleHours}h).`);
  } else {
    console.log(`Refreshing metadata for ${targets.length} repos...`);
  }

  return withSyncRun('repos', async (ctx) => {
    let unchanged = 0;
    let gone = 0;
    const samples: StarSample[] = [];

    await mapLimit(targets, 3, async (target) => {
      const outcome = await refreshOne(ctx, target, samples);
      if (outcome === 'unchanged') unchanged += 1;
      if (outcome === 'gone') gone += 1;
    });

    // One statement rather than one per repository, and after the walk rather than inside it: the
    // history is a by-product of the run, and it should not turn a 1,000-repo refresh into 1,000
    // extra round trips.
    const starSamples = await recordStars(samples);
    const newOrgs = await refreshOrganizations();

    ctx.detail = { targets: targets.length, unchanged, gone, staleHours, starSamples, newOrgs };
    console.log(`Refreshed ${ctx.reposUpserted}, unchanged ${unchanged}, gone ${gone}`);
    console.log(
      `Recorded ${starSamples} star observation(s) for today` +
        (newOrgs > 0 ? `, and ${newOrgs} new organisation(s)` : '') +
        `.`,
    );
  });
}

async function refreshOne(
  ctx: RunContext,
  target: RepoTarget,
  samples: StarSample[],
): Promise<'updated' | 'unchanged' | 'gone'> {
  const pool = db();
  const response = await ctx.gh.get<GhRepo>(`/repos/${target.full_name}`, {
    etag: target.meta_etag,
    // 404: deleted or made private. 451: unavailable for legal reasons.
    tolerate: [404, 451],
  });

  ctx.reposSeen += 1;

  if (response.status === 404 || response.status === 451) {
    await pool.query(
      `update repos set sync_state = 'gone', sync_error = $2, meta_synced_at = now() where id = $1`,
      [target.id, `HTTP ${response.status} on refresh`],
    );
    return 'gone';
  }

  if (response.status === 304) {
    await pool.query('update repos set meta_synced_at = now() where id = $1', [target.id]);
    // A 304 is an observation, not an absence of one. The ETag covers the whole representation, star
    // count included, so GitHub has just said this figure is current — and recording it keeps the
    // history dense for the quiet end of the corpus instead of leaving those repositories with one
    // ancient sample and no computable velocity.
    samples.push({ repoId: target.id, stars: target.stars });
    return 'unchanged';
  }

  const repo = response.data;
  if (!repo) return 'unchanged';

  samples.push({ repoId: target.id, stars: repo.stargazers_count });

  const written = await bulkUpsert(pool, {
    table: 'repos',
    columns: [...REPO_COLUMNS],
    rows: [mapRepoRow(repo, target.discovered_via)],
    conflictTarget: ['id'],
    updateColumns: [...REPO_UPDATE_COLUMNS],
    extraSet: ['meta_synced_at = now()', 'sync_error = null', 'sync_error_count = 0'],
  });
  ctx.reposUpserted += written;

  // Kept out of extraSet so the value stays a bound parameter rather than interpolated SQL.
  await pool.query('update repos set meta_etag = $2 where id = $1', [
    target.id,
    response.etag ?? null,
  ]);

  // A repo that becomes archived or loses its issue tracker should stop consuming issue-sync budget.
  if (repo.archived || repo.disabled || !repo.has_issues) {
    await pool.query(`update repos set sync_state = 'paused' where id = $1 and sync_state = 'active'`, [
      target.id,
    ]);
  }

  return 'updated';
}
