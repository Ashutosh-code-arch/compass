import { db, jsonb } from '../db.ts';
import { Budget, BudgetExhaustedError, GitHubRest } from '../github/rest.ts';

/**
 * Single source of truth for run kinds. Must stay in step with the sync_runs.kind CHECK constraint;
 * src/sync/run.test.ts enforces that, after a drift here made every setup run fail on insert.
 */
export const RUN_KINDS = ['seed', 'repos', 'issues', 'metrics', 'setup'] as const;

/** How often a running sync flushes its counters, so progress is visible from outside the process. */
const HEARTBEAT_MS = 3000;

export type RunKind = (typeof RUN_KINDS)[number];

export interface RunContext {
  runId: number;
  budget: Budget;
  gh: GitHubRest;
  reposSeen: number;
  reposUpserted: number;
  issuesUpserted: number;
  detail: Record<string, unknown>;
}

export interface RunSummary {
  runId: number;
  status: 'ok' | 'failed' | 'aborted_budget';
  reposSeen: number;
  reposUpserted: number;
  issuesUpserted: number;
  requests: number;
  notModified: number;
}

/**
 * Wraps a sync in a sync_runs row. A budget abort is a normal outcome, not a failure: watermarks
 * only advance for repos that fully completed, so the next run resumes without a gap.
 */
export async function withSyncRun(
  kind: RunKind,
  body: (ctx: RunContext) => Promise<void>,
): Promise<RunSummary> {
  const pool = db();
  const budget = new Budget();
  const inserted = await pool.query<{ id: number }>(
    'insert into sync_runs (kind) values ($1) returning id',
    [kind],
  );
  const runId = inserted.rows[0]!.id;

  const ctx: RunContext = {
    runId,
    budget,
    gh: new GitHubRest(budget),
    reposSeen: 0,
    reposUpserted: 0,
    issuesUpserted: 0,
    detail: {},
  };

  let status: RunSummary['status'] = 'ok';
  let error: string | null = null;
  let fatal: unknown;

  /*
   * Flush the counters periodically so a run in progress is observable.
   *
   * Previously the row was written once at the end, which meant a two-hour repos sync looked
   * identical to a hung one from outside the process. The UI polls this, and it is equally useful
   * from a second terminal during a CLI run. Failures are swallowed: a heartbeat that cannot write
   * must never be the thing that kills a sync that is otherwise working.
   */
  const heartbeat = setInterval(() => {
    void pool
      .query(
        `update sync_runs set repos_seen = $2, repos_upserted = $3, issues_upserted = $4,
                              http_requests = $5, http_not_modified = $6, graphql_points = $7
           where id = $1 and status = 'running'`,
        [
          runId,
          ctx.reposSeen,
          ctx.reposUpserted,
          ctx.issuesUpserted,
          budget.requests,
          budget.notModified,
          budget.graphqlPoints,
        ],
      )
      .catch(() => undefined);
  }, HEARTBEAT_MS);
  // Do not hold the event loop open on the CLI's account; the final write is what matters.
  heartbeat.unref?.();

  try {
    await body(ctx);
  } catch (err) {
    if (err instanceof BudgetExhaustedError) {
      status = 'aborted_budget';
      error = err.message;
      console.warn(`\n[run ${runId}] ${err.message}`);
    } else {
      status = 'failed';
      error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      fatal = err;
    }
  }

  clearInterval(heartbeat);

  await pool.query(
    `update sync_runs set
       finished_at = now(), status = $2,
       repos_seen = $3, repos_upserted = $4, issues_upserted = $5,
       http_requests = $6, http_not_modified = $7, http_retries = $8,
       graphql_points = $9,
       rate_snapshot = $10, error = $11, detail = $12
     where id = $1`,
    [
      runId,
      status,
      ctx.reposSeen,
      ctx.reposUpserted,
      ctx.issuesUpserted,
      budget.requests,
      budget.notModified,
      budget.retries,
      budget.graphqlPoints,
      jsonb(budget.toJSON()),
      error,
      jsonb(ctx.detail),
    ],
  );

  const core = budget.get('core');
  const graphql = budget.get('graphql');
  console.log(`[run ${runId}] ${kind} ${status} | ${budget.summary()}`);
  if (core && budget.billedRequests > 0) {
    console.log(
      `[run ${runId}] billed ${budget.billedRequests} requests = ` +
        `${((budget.billedRequests / core.limit) * 100).toFixed(1)}% of hourly core budget`,
    );
  }
  if (graphql && budget.graphqlPoints > 0) {
    console.log(
      `[run ${runId}] spent ${budget.graphqlPoints} graphql points = ` +
        `${((budget.graphqlPoints / graphql.limit) * 100).toFixed(1)}% of hourly graphql budget`,
    );
  }

  if (fatal) throw fatal;

  return {
    runId,
    status,
    reposSeen: ctx.reposSeen,
    reposUpserted: ctx.reposUpserted,
    issuesUpserted: ctx.issuesUpserted,
    requests: budget.requests,
    notModified: budget.notModified,
  };
}
