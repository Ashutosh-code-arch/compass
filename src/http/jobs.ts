/**
 * Running a sync from the UI.
 *
 * These jobs take minutes to hours and spend a rate-limited external budget, so they cannot be a
 * request/response. A POST starts one and returns immediately; the row in `sync_runs` is the
 * progress, flushed by the heartbeat in `withSyncRun`.
 *
 * Three deliberate constraints:
 *
 * 1. **One at a time.** Two syncs racing would double the request rate against a shared hourly
 *    budget and, for `repos`, write the same rows twice. The lock is in-process, which is honest
 *    about what it can enforce: a CLI run in another terminal is invisible to it, so
 *    `runningInDatabase` reports those separately rather than pretending to guard them.
 * 2. **No cancellation.** Offering a stop button that cannot interrupt an in-flight HTTP request
 *    would be a lie. A run aborts on budget exhaustion by design, and watermarks make it resumable.
 * 3. **The token is checked before starting**, so a missing `GITHUB_TOKEN` is a clear message rather
 *    than a failed run in the history.
 */

import { db } from '../db.ts';
import { loadConfig } from '../config.ts';
import { syncIssues } from '../sync/issues.ts';
import { syncMetrics } from '../sync/metrics.ts';
import { syncRepos } from '../sync/repos.ts';
import { syncSetup } from '../sync/setup.ts';
import { seed } from '../sync/seed.ts';
import { RUN_KINDS, type RunKind, type RunSummary } from '../sync/run.ts';
import { addAndPrepare } from '../sync/add.ts';

export { RUN_KINDS, type RunKind };

export function isRunKind(value: string): value is RunKind {
  return (RUN_KINDS as readonly string[]).includes(value);
}

/** Options a caller may set. Everything else stays at the defaults the CLI uses. */
export interface JobOptions {
  limit?: number;
  repo?: string;
  /** `repos` counts staleness in hours; `metrics` and `setup` count it in days. */
  staleHours?: number;
  staleDays?: number;
}

export interface ActiveJob {
  kind: RunKind;
  startedAt: string;
  options: JobOptions;
  /** Set when the job is an `add`, so the UI names the project instead of saying "repos". */
  adding?: string;
}

let active: (ActiveJob & { promise: Promise<unknown> }) | null = null;

export class JobBusyError extends Error {}
export class JobConfigError extends Error {}

export function activeJob(): ActiveJob | null {
  if (!active) return null;
  return {
    kind: active.kind,
    startedAt: active.startedAt,
    options: active.options,
    ...(active.adding !== undefined ? { adding: active.adding } : {}),
  };
}

/**
 * One place for the two preconditions every job shares, so they cannot drift apart.
 */
function guard(): void {
  if (active) {
    throw new JobBusyError(
      `A ${active.adding ? `add of ${active.adding}` : `${active.kind} sync`} is already running in ` +
        `this server, started ${active.startedAt}. Scans share one hourly GitHub budget, so they run ` +
        `one at a time.`,
    );
  }
  if (!loadConfig().githubToken) {
    throw new JobConfigError(
      'No GITHUB_TOKEN is set, so this server cannot reach GitHub. Add one to .env and restart.',
    );
  }
}

/**
 * The reason the last add failed.
 *
 * Surfaced separately because a failed add leaves no useful trace otherwise: the `sync_runs` row says a
 * `repos` run happened, not that a particular project could not be found.
 */
let addError: string | null = null;

export function lastAddError(): string | null {
  return addError;
}

export function clearAddError(): void {
  addError = null;
}

/**
 * Adds a project and runs the three scans that make it rankable.
 *
 * Shares the lock with the other scans: it fetches issues, metrics and setup for the repository, so
 * running it alongside a corpus-wide sync would double the request rate against one hourly budget.
 */
export async function startAdd(ref: string, metadataOnly = false): Promise<ActiveJob> {
  guard();
  const job: ActiveJob = {
    kind: 'repos',
    startedAt: new Date().toISOString(),
    options: {},
    adding: ref,
  };
  const promise = addAndPrepare(ref, metadataOnly ? { metadataOnly: true } : {})
    .catch((error: unknown) => {
      // The caller already has its 202, so this is recorded rather than thrown.
      addError = error instanceof Error ? error.message : String(error);
      console.error(`[api] add ${ref} failed: ${addError}`);
    })
    .finally(() => {
      active = null;
    });
  active = { ...job, promise };
  return job;
}

/**
 * Runs of any kind that the database believes are still going.
 *
 * Two causes: a CLI run in another terminal, or a process that died mid-run and left the row at
 * 'running' forever. They are indistinguishable from here, so both are reported with their last
 * heartbeat and the UI says as much rather than guessing.
 */
export async function runningInDatabase(): Promise<
  { runId: number; kind: string; startedAt: string; heartbeatRequests: number }[]
> {
  const rows = (
    await db().query<{ id: string; kind: string; started_at: Date; http_requests: number }>(
      `select id::text, kind, started_at, http_requests
         from sync_runs where status = 'running' order by started_at desc limit 10`,
    )
  ).rows;
  return rows.map((row) => ({
    runId: Number(row.id),
    kind: row.kind,
    startedAt: row.started_at.toISOString(),
    heartbeatRequests: row.http_requests,
  }));
}

function runner(kind: RunKind, options: JobOptions): Promise<RunSummary> {
  const limit = options.limit !== undefined ? { limit: options.limit } : {};
  const repo = options.repo !== undefined ? { repo: options.repo } : {};
  switch (kind) {
    case 'seed':
      // Seed takes maxPages rather than a row limit: it runs the discovery queries in
      // seeds/queries.ts, and pages are the only knob that bounds their cost.
      return seed(options.limit !== undefined ? { maxPages: options.limit } : {});
    case 'repos':
      return syncRepos({
        ...limit,
        ...repo,
        ...(options.staleHours !== undefined ? { staleHours: options.staleHours } : {}),
      });
    case 'issues':
      return syncIssues({ ...limit, ...repo });
    case 'metrics':
      return syncMetrics({
        ...limit,
        ...repo,
        ...(options.staleDays !== undefined ? { staleDays: options.staleDays } : {}),
      });
    case 'setup':
      return syncSetup({
        ...limit,
        ...repo,
        ...(options.staleDays !== undefined ? { staleDays: options.staleDays } : {}),
      });
  }
}

/**
 * Starts a sync and returns once it is under way, not once it finishes.
 *
 * The returned promise is deliberately not awaited by the caller. It is retained so a second start
 * can be refused while the first is in flight, and so an unhandled rejection cannot take the server
 * down — the outcome is recorded in `sync_runs` either way, which is where the UI reads it.
 */
export async function startJob(kind: RunKind, options: JobOptions = {}): Promise<ActiveJob> {
  guard();
  const job = { kind, startedAt: new Date().toISOString(), options };
  const promise = runner(kind, options)
    .catch((error: unknown) => {
      // withSyncRun already recorded the failure; this only keeps the process alive.
      console.error(`[api] ${kind} sync failed:`, error);
      return {
        runId: -1,
        status: 'failed',
        reposSeen: 0,
        reposUpserted: 0,
        issuesUpserted: 0,
        requests: 0,
        notModified: 0,
      } satisfies RunSummary;
    })
    .finally(() => {
      active = null;
    });

  active = { ...job, promise };
  return job;
}

export interface RunRecord {
  runId: number;
  kind: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  reposSeen: number;
  reposUpserted: number;
  issuesUpserted: number;
  requests: number;
  notModified: number;
  error: string | null;
}

export async function recentRuns(limit = 12): Promise<RunRecord[]> {
  const rows = (
    await db().query<{
      id: string;
      kind: string;
      status: string;
      started_at: Date;
      finished_at: Date | null;
      repos_seen: number;
      repos_upserted: number;
      issues_upserted: number;
      http_requests: number;
      http_not_modified: number;
      error: string | null;
    }>(
      `select id::text, kind, status, started_at, finished_at, repos_seen, repos_upserted,
              issues_upserted, http_requests, http_not_modified, error
         from sync_runs order by started_at desc limit $1`,
      [limit],
    )
  ).rows;

  return rows.map((row) => ({
    runId: Number(row.id),
    kind: row.kind,
    status: row.status,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
    reposSeen: row.repos_seen,
    reposUpserted: row.repos_upserted,
    issuesUpserted: row.issues_upserted,
    requests: row.http_requests,
    notModified: row.http_not_modified,
    error: row.error,
  }));
}

/**
 * What to do next, given what the corpus is missing.
 *
 * The corpus screen offers five buttons and previously said nothing about which one to press. Four of
 * them must run in order before anything is rankable, so a newcomer clicking at random gets a screen
 * that stays empty and no explanation. This is the pipeline expressed as a single instruction.
 */
export interface NextStep {
  kind: RunKind | 'ready';
  /** Why this is the next thing, in the reader's terms. */
  because: string;
}

export function nextStep(corpus: CorpusSummary): NextStep {
  const active = corpus.repos - corpus.pausedRepos;

  if (corpus.repos === 0) {
    return {
      kind: 'seed',
      because: 'There are no projects yet. Find some, or add one by name.',
    };
  }
  if (corpus.issues === 0) {
    return {
      kind: 'issues',
      because: `${corpus.repos.toLocaleString()} projects, but no issues. Nothing can be ranked yet.`,
    };
  }
  // Metrics before setup: responsiveness is the heaviest signal and a dormant project is gated out
  // entirely, so measuring attention changes the shortlist far more than reading setup files does.
  if (corpus.reposWithMetrics === 0) {
    return {
      kind: 'metrics',
      because:
        'No project has been measured for maintainer attention yet, which is the signal that ' +
        'matters most. Until this runs, the ranking is mostly guessing.',
    };
  }
  if (corpus.reposWithMetrics < active / 2) {
    return {
      kind: 'metrics',
      because:
        `Only ${corpus.reposWithMetrics.toLocaleString()} of ${active.toLocaleString()} active ` +
        `projects have been measured. The unmeasured ones cannot compete fairly.`,
    };
  }
  if (corpus.reposWithSetup < active / 2) {
    return {
      kind: 'setup',
      because:
        `${corpus.reposWithSetup.toLocaleString()} of ${active.toLocaleString()} projects have had ` +
        `their setup cost read. Without it, setup contributes nothing either way.`,
    };
  }
  if (corpus.staleMetadata > active / 2) {
    return {
      kind: 'repos',
      because:
        `${corpus.staleMetadata.toLocaleString()} projects have metadata over a day old. This is ` +
        `cheap — unchanged projects cost no quota at all.`,
    };
  }
  return {
    kind: 'ready',
    because:
      'The corpus is in good shape. The most useful thing now is not another scan — it is working ' +
      'an issue and recording how long it actually took.',
  };
}

export interface CorpusSummary {
  repos: number;
  pausedRepos: number;
  issues: number;
  openIssues: number;
  reposWithMetrics: number;
  reposWithSetup: number;
  /** Active repos whose metadata has not been refreshed in the last day. */
  staleMetadata: number;
  decisions: number;
}

/**
 * Enough corpus context for the sync buttons to mean something.
 *
 * Purpose-written rather than reusing `status.ts`, which still mixes its queries with terminal
 * formatting and would have to be split first. Noted in the handoff as remaining work; duplicating
 * six counts is cheaper today than that refactor, and this is the honest place to say so.
 */
export async function corpusSummary(): Promise<CorpusSummary> {
  const row = (
    await db().query<Record<string, string>>(
      `select (select count(*) from repos)                                          as repos,
              (select count(*) from repos where sync_state = 'paused')              as paused_repos,
              (select count(*) from issues)                                         as issues,
              (select count(*) from issues where state = 'open')                    as open_issues,
              (select count(*) from repo_metrics)                                   as repos_with_metrics,
              (select count(*) from setup_facts)                                    as repos_with_setup,
              (select count(*) from repos
                where sync_state = 'active'
                  and (meta_synced_at is null
                       or meta_synced_at < now() - interval '24 hours'))        as stale_metadata,
              (select count(*) from decisions)                                      as decisions`,
    )
  ).rows[0]!;

  const n = (key: string): number => Number(row[key] ?? 0);
  return {
    repos: n('repos'),
    pausedRepos: n('paused_repos'),
    issues: n('issues'),
    openIssues: n('open_issues'),
    reposWithMetrics: n('repos_with_metrics'),
    reposWithSetup: n('repos_with_setup'),
    staleMetadata: n('stale_metadata'),
    decisions: n('decisions'),
  };
}
