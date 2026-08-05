import { loadConfig } from '../config.ts';
import { db, jsonb } from '../db.ts';
import { GitHubGraphQL } from '../github/graphql.ts';
import { mapLimit } from '../github/rest.ts';
import { computeMetrics, type RepoMetrics } from '../metrics/compute.ts';
import {
  type GqlRepository,
  type QueueDepth,
  buildMaintainerRoster,
  buildMetricsQuery,
  mapPullRequest,
  mapQueueDepth,
} from './metrics_query.ts';
import { withSyncRun, type RunSummary } from './run.ts';

export interface SyncMetricsOptions {
  /** Maintainer behaviour moves slowly, so a week-old metric is still a good metric. */
  staleDays?: number;
  limit?: number;
  repo?: string;
  /** How far back to look for external PRs. */
  windowDays?: number;
  /** Open, unanswered PRs older than this count as stalled. */
  prStaleDays?: number;
  /** Below this age, an unanswered PR is too recent to judge rather than ignored. */
  graceDays?: number;
  /** PRs fetched per repo. Raising this raises the point cost roughly linearly. */
  prCount?: number;
  /** Repos per GraphQL request. Cuts round trips; does not change point cost. */
  batchSize?: number;
}

interface MetricTarget {
  id: number;
  owner: string;
  name: string;
  full_name: string;
}

const REVIEW_COUNT = 8;
const COMMENT_COUNT = 5;

/**
 * Point budget, for reference. GitHub charges roughly (nodes requested / 100) per query:
 * 40 PRs x (1 + 8 reviews + 5 comments) = 560 nodes, about 6 points per repo. A 200-repo run is
 * therefore ~1,200 of the 5,000 hourly points. With the default 7-day staleness gate, a 500-repo
 * corpus needs about 70 repos a day — a few hundred points. The real cost is read back from each
 * response, so `status` reports measured usage rather than this estimate.
 */
export async function syncMetrics(options: SyncMetricsOptions = {}): Promise<RunSummary> {
  const staleDays = options.staleDays ?? 7;
  const windowDays = options.windowDays ?? 180;
  const prStaleDays = options.prStaleDays ?? 60;
  const graceDays = options.graceDays ?? 7;
  const prCount = options.prCount ?? 40;
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 5, 20));
  const pool = db();

  const targets = options.repo
    ? (
        await pool.query<MetricTarget>(
          `select id, owner, name, full_name from repos where full_name = $1`,
          [options.repo],
        )
      ).rows
    : (
        await pool.query<MetricTarget>(
          `select r.id, r.owner, r.name, r.full_name
             from repos r
             left join repo_metrics m on m.repo_id = r.id
            where r.sync_state = 'active'
              and (m.computed_at is null
                   or m.computed_at < now() - make_interval(days => $1::int))
            order by m.computed_at nulls first, r.stars desc
            limit $2`,
          [staleDays, options.limit ?? 200],
        )
      ).rows;

  if (targets.length === 0) {
    console.log(`Nothing to compute (all metrics newer than ${staleDays}d).`);
  } else {
    console.log(
      `Computing maintainer metrics for ${targets.length} repos ` +
        `(${prCount} PRs each, ${windowDays}d window, batches of ${batchSize})...`,
    );
  }

  const batches: MetricTarget[][] = [];
  for (let index = 0; index < targets.length; index += batchSize) {
    batches.push(targets.slice(index, index + batchSize));
  }

  return withSyncRun('metrics', async (ctx) => {
    const graphql = new GitHubGraphQL(ctx.budget);
    const ignoreLogins = loadConfig().ignoredLogins;
    let computed = 0;
    let missing = 0;
    const distribution: Record<string, number> = {};

    const started = Date.now();
    let done = 0;
    let failedBatches = 0;
    const errors: string[] = [];

    await mapLimit(batches, 2, async (batch, batchIndex) => {
      try {
        await processBatch(batch);
      } catch (err) {
        // A budget abort must still stop the whole run: continuing would burn the reserve.
        if (err instanceof Error && err.name === 'BudgetExhaustedError') throw err;
        failedBatches += 1;
        const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        if (errors.length < 5) errors.push(message.slice(0, 300));
        console.warn(
          `[metrics] batch ${batchIndex + 1} (${batch[0]?.full_name} +${batch.length - 1}) failed: ` +
            message.slice(0, 160),
        );
      }

      done += batch.length;
      // Progress output matters here: without it this runs silently for over ten minutes, which is
      // indistinguishable from a hang and invites killing it.
      if (done % 100 < batch.length || done === targets.length) {
        const elapsed = Math.round((Date.now() - started) / 1000);
        console.log(
          `  ${done}/${targets.length} repos  ${elapsed}s  ${ctx.budget.graphqlPoints} points` +
            (failedBatches > 0 ? `  ${failedBatches} batch failures` : ''),
        );
      }
    });

    async function processBatch(batch: MetricTarget[]): Promise<void> {
      const query = buildMetricsQuery(batch.length);
      const variables: Record<string, unknown> = {
        prCount,
        reviewCount: REVIEW_COUNT,
        commentCount: COMMENT_COUNT,
      };
      batch.forEach((target, index) => {
        variables[`o${index}`] = target.owner;
        variables[`n${index}`] = target.name;
      });

      const { data, partialErrors } = await graphql.query<Record<string, GqlRepository | null>>(
        query,
        variables,
      );

      for (const [index, target] of batch.entries()) {
        const repository = data[`r${index}`];

        if (!repository) {
          // A null alias means that one repo failed while its batch-mates succeeded.
          const error = partialErrors.find((entry) => entry.path?.[0] === `r${index}`);
          missing += 1;
          await pool.query(
            `update repos set sync_state = 'gone', sync_error = $2 where id = $1`,
            [target.id, `metrics: ${error?.type ?? 'NOT_FOUND'} ${error?.message ?? ''}`.slice(0, 500)],
          );
          console.warn(`[metrics] ${target.full_name}: ${error?.type ?? 'not found'}, marked gone`);
          continue;
        }

        const nodes = repository.pullRequests.nodes.filter(
          (node): node is NonNullable<typeof node> => node !== null,
        );
        // Built from the whole sample before mapping, so a maintainer identified on any PR is
        // recognised on all of them.
        const roster = buildMaintainerRoster(repository, nodes, ignoreLogins);
        const observations = nodes.map((pr) => mapPullRequest(pr, { ignoreLogins, roster }));

        const metrics = computeMetrics(observations, {
          windowDays,
          staleDays: prStaleDays,
          graceDays,
        });

        await storeMetrics(target.id, metrics, roster.size, mapQueueDepth(repository));
        computed += 1;
        ctx.reposSeen += 1;
        distribution[metrics.responsiveness] = (distribution[metrics.responsiveness] ?? 0) + 1;
      }
    }

    ctx.detail = {
      computed, missing, failedBatches, sampleErrors: errors,
      staleDays, windowDays, prCount, batchSize, graceDays,
      ignoredLogins: [...ignoreLogins], distribution,
    };
    console.log(`Computed ${computed}, unreachable ${missing}, failed batches ${failedBatches}`);
    if (failedBatches > 0) {
      console.log(
        `  Rerun to retry the failures — processed repos sort last, so progress is not lost.`,
      );
    }
    if (Object.keys(distribution).length > 0) {
      const summary = Object.entries(distribution)
        .sort((a, b) => b[1] - a[1])
        .map(([bucket, count]) => `${bucket} ${count}`)
        .join(', ');
      console.log(`Responsiveness: ${summary}`);
    }
  });
}

const METRIC_COLUMNS = [
  'repo_id',
  'computed_at',
  'window_days',
  'stale_days',
  'grace_days',
  'prs_scanned',
  'prs_in_window',
  'insider_prs',
  'bot_prs',
  'external_prs',
  'responded_prs',
  'too_recent_prs',
  'decidable_prs',
  'median_hours_response',
  'p90_hours_response',
  'no_response_rate',
  'merged_prs',
  'closed_unmerged_prs',
  'open_prs',
  'merge_rate',
  'median_hours_to_merge',
  'changes_requested_rate',
  'open_stale_prs',
  'open_stale_rate',
  'hours_since_last_action',
  'confidence',
  'responsiveness',
  'detail',
  // Added in 012. Queue depth, which is a property of the repository rather than of the sample.
  'open_pr_total',
  'oldest_open_pr_at',
  'oldest_open_pr_number',
];

async function storeMetrics(
  repoId: number,
  metrics: RepoMetrics,
  rosterSize: number,
  queue: QueueDepth,
): Promise<void> {
  const values = [
    repoId,
    new Date().toISOString(),
    metrics.windowDays,
    metrics.staleDays,
    metrics.graceDays,
    metrics.prsScanned,
    metrics.prsInWindow,
    metrics.insiderPrs,
    metrics.botPrs,
    metrics.externalPrs,
    metrics.respondedPrs,
    metrics.tooRecentPrs,
    metrics.decidablePrs,
    metrics.medianHoursResponse,
    metrics.p90HoursResponse,
    metrics.noResponseRate,
    metrics.mergedPrs,
    metrics.closedUnmergedPrs,
    metrics.openPrs,
    metrics.mergeRate,
    metrics.medianHoursToMerge,
    metrics.changesRequestedRate,
    metrics.openStalePrs,
    metrics.openStaleRate,
    metrics.hoursSinceLastAction,
    metrics.confidence,
    metrics.responsiveness,
    jsonb({ perPr: metrics.perPr, maintainersKnown: rosterSize }),
    queue.openPrs,
    queue.oldestOpenPrAt,
    queue.oldestOpenPrNumber,
  ];

  const placeholders = values.map((_unused, index) => `$${index + 1}`).join(', ');
  const updates = METRIC_COLUMNS.slice(1)
    .map((column) => `${column} = excluded.${column}`)
    .join(', ');

  await db().query(
    `insert into repo_metrics (${METRIC_COLUMNS.join(', ')}) values (${placeholders})
     on conflict (repo_id) do update set ${updates}`,
    values,
  );
}
