import { bulkUpsert, db } from '../db.ts';
import { mapLimit } from '../github/rest.ts';
import { isPullRequest, type GhIssue } from '../github/types.ts';
import { ISSUE_COLUMNS, ISSUE_UPDATE_COLUMNS, mapIssueRow } from './map.ts';
import { withSyncRun, type RunContext, type RunSummary } from './run.ts';

export interface SyncIssuesOptions {
  limit?: number;
  repo?: string;
  /** Page cap for the initial pull, so one huge tracker can't eat a whole run. 100 issues/page. */
  backfillMaxPages?: number;
  /** Page cap per repo for incremental passes. */
  incrementalMaxPages?: number;
}

interface IssueTarget {
  id: number;
  full_name: string;
  issues_synced_at: Date | null;
  issues_backfilled: boolean;
  issues_backfill_page: number;
  sync_error_count: number;
}

/** Re-ask for a few minutes either side of the watermark; cheap insurance against clock skew. */
const OVERLAP_MS = 5 * 60 * 1000;
const PAUSE_AFTER_ERRORS = 5;

/**
 * Two modes per repo:
 *
 *   Backfill (first time): state=open, sorted by created ascending. created_at never changes, so
 *   pagination is stable even while the tracker is active — sorting by `updated` mid-write is how
 *   you silently skip pages.
 *
 *   Incremental (thereafter): state=all with `since` set to the stored watermark. Asking for `all`
 *   rather than `open` is what lets locally-open issues learn they were closed; a closed issue has
 *   its updated_at bumped, so it comes back through the same window.
 *
 * The watermark only advances when every page for that repo landed, so an aborted run resumes
 * without a gap.
 */
export async function syncIssues(options: SyncIssuesOptions = {}): Promise<RunSummary> {
  const pool = db();

  const targets = options.repo
    ? (
        await pool.query<IssueTarget>(
          `select id, full_name, issues_synced_at, issues_backfilled, issues_backfill_page,
                  sync_error_count
             from repos where full_name = $1`,
          [options.repo],
        )
      ).rows
    : (
        await pool.query<IssueTarget>(
          `select id, full_name, issues_synced_at, issues_backfilled, issues_backfill_page,
                  sync_error_count
             from repos
            where sync_state = 'active' and has_issues
            order by issues_synced_at nulls first
            limit $1`,
          [options.limit ?? 1000],
        )
      ).rows;

  console.log(`Syncing issues for ${targets.length} repos...`);

  return withSyncRun('issues', async (ctx) => {
    let truncated = 0;
    let failed = 0;

    await mapLimit(targets, 3, async (target) => {
      try {
        const result = await syncOne(ctx, target, options);
        if (result.truncated) truncated += 1;
      } catch (err) {
        // Budget aborts must propagate: stopping the whole run is what keeps the watermark honest.
        if (err instanceof Error && err.name === 'BudgetExhaustedError') throw err;
        failed += 1;
        // recordFailure swallows its own errors; this guard is belt and braces so nothing in the
        // failure path can take down the remaining repos.
        await recordFailure(target, err).catch(() => {});
      }
    });

    ctx.detail = { targets: targets.length, truncated, failed };
    console.log(
      `Upserted ${ctx.issuesUpserted} issues | ${truncated} repos hit the page cap | ${failed} failed`,
    );
  });
}

async function syncOne(
  ctx: RunContext,
  target: IssueTarget,
  options: SyncIssuesOptions,
): Promise<{ truncated: boolean }> {
  const pool = db();
  // Captured before the first request so anything updated mid-sync is caught next run.
  const runStart = new Date();

  const backfilling = !target.issues_backfilled;
  const maxPages = backfilling
    ? (options.backfillMaxPages ?? 20)
    : (options.incrementalMaxPages ?? 10);

  // Resume where the last truncated backfill stopped. Pages are ordered by created_at ascending,
  // which never changes for an existing issue, so earlier pages cannot shift under us — new issues
  // only ever land on later pages.
  const startPage = backfilling ? target.issues_backfill_page + 1 : 1;

  const query: Record<string, string | number> = backfilling
    ? { state: 'open', sort: 'created', direction: 'asc', per_page: 100, page: startPage }
    : {
        state: 'all',
        sort: 'updated',
        direction: 'asc',
        per_page: 100,
        since: new Date(
          (target.issues_synced_at?.getTime() ?? 0) - OVERLAP_MS,
        ).toISOString(),
      };

  let pagesSeen = 0;
  let lastPageFull = false;
  let lastUpdatedSeen: string | null = null;
  // Absolute page number, so the cursor survives across runs.
  let lastCompletePage = backfilling ? target.issues_backfill_page : 0;

  for await (const page of ctx.gh.paginate<GhIssue>(
    `/repos/${target.full_name}/issues`,
    query,
    { maxPages },
  )) {
    pagesSeen = page.page;
    lastPageFull = page.items.length === 100;
    if (backfilling) lastCompletePage = startPage + page.page - 1;

    // Boundary is defined over every item the API returned, pull requests included, since they
    // occupy positions in the same ascending-updated ordering.
    for (const item of page.items) {
      if (!lastUpdatedSeen || item.updated_at > lastUpdatedSeen) lastUpdatedSeen = item.updated_at;
    }

    // The REST issues endpoint returns pull requests as issues. `pull_request` is the only
    // reliable discriminator, and forgetting it silently doubles the corpus with PRs.
    const issues = page.items.filter((item) => !isPullRequest(item));
    if (issues.length === 0) continue;

    const written = await bulkUpsert(pool, {
      table: 'issues',
      columns: [...ISSUE_COLUMNS],
      rows: issues.map((issue) => mapIssueRow(issue, target.id)),
      conflictTarget: ['id'],
      updateColumns: [...ISSUE_UPDATE_COLUMNS],
      extraSet: ['last_synced_at = now()'],
    });
    ctx.issuesUpserted += written;
  }

  const truncated = pagesSeen >= maxPages && lastPageFull;

  // A truncated *backfill* must not advance the watermark or flip issues_backfilled: doing so
  // would switch the repo to incremental mode and permanently strand the open issues we never
  // reached. Backfill pages are stable (created ascending), so redoing them is idempotent.
  if (backfilling && truncated) {
    // Save the cursor instead of the watermark. The repo stays un-backfilled, so the next run
    // resumes at the following page rather than starting over.
    await pool.query(
      `update repos set
         issues_backfill_page = $2::int,
         sync_error = $3,
         sync_error_count = 0
       where id = $1`,
      [
        target.id,
        lastCompletePage,
        `backfill paused after page ${lastCompletePage} (${maxPages}-page cap per run)`,
      ],
    );
    console.warn(
      `[issues] ${target.full_name}: backfill reached page ${lastCompletePage}; ` +
        `the next run continues from there.`,
    );
    return { truncated };
  }

  // Normal completion: everything up to runStart is accounted for.
  // Truncated incremental pass: the pages we got were the *oldest* updates in the window, so the
  // watermark may only advance as far as the last update we actually saw. Advancing to runStart
  // would skip the newer tail forever.
  const watermark =
    truncated && lastUpdatedSeen ? lastUpdatedSeen : runStart.toISOString();

  await pool.query(
    `update repos set
       issues_synced_at = $2,
       issues_backfilled = true,
       issues_backfill_page = 0,
       sync_error = null,
       sync_error_count = 0
     where id = $1`,
    [target.id, watermark],
  );

  if (truncated) {
    console.warn(
      `[issues] ${target.full_name}: incremental pass hit the ${maxPages}-page cap; ` +
        `watermark held at ${watermark}, remainder arrives next run.`,
    );
  }

  return { truncated };
}

async function recordFailure(target: IssueTarget, err: unknown): Promise<void> {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const nextCount = target.sync_error_count + 1;

  // Report before recording. Bookkeeping is allowed to fail; losing the original error is not.
  console.warn(`[issues] ${target.full_name} failed (${nextCount}): ${message.slice(0, 200)}`);

  try {
    await db().query(
      // $3 is cast explicitly because it appears both as an integer assignment and inside a
      // comparison whose other operand is also a parameter. With two unknowns, Postgres resolves
      // the comparison as text and then rejects the statement: "inconsistent types deduced for
      // parameter $3".
      `update repos set
         sync_error = $2,
         sync_error_count = $3::int,
         sync_state = case when $3::int >= $4::int then 'paused' else sync_state end
       where id = $1`,
      [target.id, message.slice(0, 1000), nextCount, PAUSE_AFTER_ERRORS],
    );
  } catch (bookkeepingError) {
    console.warn(
      `[issues] could not record the failure for ${target.full_name}: ` +
        `${bookkeepingError instanceof Error ? bookkeepingError.message : String(bookkeepingError)}`,
    );
  }
}
