import { bulkUpsert, db } from '../db.ts';
import type { GhRepo, GhSearchResponse } from '../github/types.ts';
import { activeQueries, makeSeedContext, type SeedQuery } from '../seeds/queries.ts';
import { mapRepoRow, REPO_COLUMNS, REPO_UPDATE_COLUMNS } from './map.ts';
import { withSyncRun, type RunContext, type RunSummary } from './run.ts';

export interface SeedOptions {
  /** Print the resolved query strings and result counts without writing anything. */
  dryRun?: boolean;
  /** Restrict to specific seed query ids. */
  only?: string[];
  /** Override each query's maxPages. */
  maxPages?: number;
}

const PER_PAGE = 100;

/**
 * Discovery only. Search payloads are slightly thinner than the single-repo endpoint (no
 * subscribers_count, sometimes no topics), so this deliberately leaves meta_synced_at null —
 * `sync repos` then fills in canonical metadata on its next pass.
 */
export async function seed(options: SeedOptions = {}): Promise<RunSummary> {
  const context = makeSeedContext();
  let queries = activeQueries();
  if (options.only?.length) {
    const wanted = new Set(options.only);
    queries = queries.filter((query) => wanted.has(query.id));
    const missing = [...wanted].filter((id) => !queries.some((query) => query.id === id));
    if (missing.length) throw new Error(`Unknown seed query id(s): ${missing.join(', ')}`);
  }
  if (queries.length === 0) throw new Error('No enabled seed queries.');

  return withSyncRun('seed', async (ctx) => {
    const perQuery: Record<string, { found: number; written: number; total: number }> = {};

    for (const query of queries) {
      const q = query.build(context);
      const maxPages = options.maxPages ?? query.maxPages ?? 3;

      if (options.dryRun) {
        console.log(`\n${query.id}  (${query.note})`);
        console.log(`  q: ${q}`);
        console.log(`  sort: ${query.sort ?? 'best-match'}  maxPages: ${maxPages}`);
        continue;
      }

      const result = await runQuery(ctx, query, q, maxPages);
      perQuery[query.id] = result;
      console.log(
        `${query.id.padEnd(18)} ${String(result.found).padStart(4)} fetched of ${result.total} matches, ${result.written} rows written`,
      );
    }

    ctx.detail = { queries: perQuery, dryRun: options.dryRun ?? false };
  });
}

async function runQuery(
  ctx: RunContext,
  query: SeedQuery,
  q: string,
  maxPages: number,
): Promise<{ found: number; written: number; total: number }> {
  let found = 0;
  let written = 0;
  let total = 0;
  const pool = db();

  for (let page = 1; page <= maxPages; page += 1) {
    const response = await ctx.gh.get<GhSearchResponse<GhRepo>>('/search/repositories', {
      query: {
        q,
        per_page: PER_PAGE,
        page,
        ...(query.sort ? { sort: query.sort, order: 'desc' } : {}),
      },
    });

    const body = response.data;
    if (!body) break;
    total = body.total_count;

    if (body.items.length === 0) break;
    found += body.items.length;
    ctx.reposSeen += body.items.length;

    const rows = body.items.map((repo) => mapRepoRow(repo, query.id));
    const count = await bulkUpsert(pool, {
      table: 'repos',
      columns: [...REPO_COLUMNS],
      rows,
      conflictTarget: ['id'],
      updateColumns: [...REPO_UPDATE_COLUMNS],
    });
    written += count;
    ctx.reposUpserted += count;

    // Search never returns past 1,000 results however you paginate.
    if (body.items.length < PER_PAGE || page * PER_PAGE >= Math.min(total, 1000)) break;
  }

  return { found, written, total };
}
