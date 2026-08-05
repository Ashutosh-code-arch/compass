import { db } from './db.ts';
import { starHistoryCoverage } from './sync/stars.ts';

interface CorpusRow {
  repos: number;
  active: number;
  paused: number;
  gone: number;
  backfilled: number;
  never_synced: number;
  stale_24h: number;
}

interface RunRow {
  id: number;
  kind: string;
  status: string;
  started_at: Date;
  seconds: number | null;
  repos_upserted: number;
  issues_upserted: number;
  http_requests: number;
  http_not_modified: number;
  graphql_points: number;
  core_limit: number | null;
  graphql_limit: number | null;
  error: string | null;
  failed_batches: number | null;
}

export async function status(): Promise<void> {
  const pool = db();

  const corpus = (
    await pool.query<CorpusRow>(`
      select
        count(*)::int                                                              as repos,
        count(*) filter (where sync_state = 'active')::int                         as active,
        count(*) filter (where sync_state = 'paused')::int                         as paused,
        count(*) filter (where sync_state = 'gone')::int                           as gone,
        -- Must share the denominator below, or paused repos inflate it past the total.
        count(*) filter (where issues_backfilled and sync_state = 'active')::int   as backfilled,
        count(*) filter (where issues_synced_at is null
                            and sync_state = 'active')::int                        as never_synced,
        count(*) filter (where meta_synced_at is null
                            or meta_synced_at < now() - interval '24 hours')::int  as stale_24h
      from repos`)
  ).rows[0];

  const issues = (
    await pool.query<{ total: number; open: number; unassigned: number; labelled: number }>(`
      select
        count(*)::int                                                as total,
        count(*) filter (where state = 'open')::int                  as open,
        count(*) filter (where state = 'open'
                           and assignee_logins = '{}')::int          as unassigned,
        count(*) filter (where state = 'open'
                           and labels && array['good first issue','help wanted',
                                               'good-first-issue','help-wanted'])::int as labelled
      from issues`)
  ).rows[0];

  console.log('\nCorpus');
  if (!corpus || corpus.repos === 0) {
    console.log('  empty — run `npm run compass -- seed` first');
  } else {
    console.log(`  repos            ${corpus.repos} (${corpus.active} active, ${corpus.paused} paused, ${corpus.gone} gone)`);
    console.log(`  issues backfilled ${corpus.backfilled}/${corpus.active} active repos`);
    console.log(`  never issue-synced ${corpus.never_synced}`);
    console.log(`  metadata stale >24h ${corpus.stale_24h}`);
  }

  if (issues && issues.total > 0) {
    console.log('\nIssues');
    console.log(`  total            ${issues.total} (${issues.open} open)`);
    console.log(`  open, unassigned ${issues.unassigned}`);
    console.log(`  open, beginner-labelled ${issues.labelled}`);
  }

  const metrics = (
    await pool.query<{ responsiveness: string; confidence: string; n: number }>(`
      select responsiveness, confidence, count(*)::int as n
        from repo_metrics
       group by responsiveness, confidence
       order by responsiveness, confidence`)
  ).rows;

  if (metrics.length > 0) {
    const total = metrics.reduce((sum, row) => sum + row.n, 0);
    const byBucket = new Map<string, number>();
    let trustworthy = 0;
    for (const row of metrics) {
      byBucket.set(row.responsiveness, (byBucket.get(row.responsiveness) ?? 0) + row.n);
      if (row.confidence === 'medium' || row.confidence === 'high') trustworthy += row.n;
    }
    console.log('\nMaintainer metrics');
    console.log(`  computed for      ${total} repos (${trustworthy} with a usable sample size)`);
    for (const [bucket, count] of [...byBucket].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${bucket.padEnd(16)} ${count}`);
    }
    const stale = (
      await pool.query<{ n: number }>(
        `select count(*)::int as n from repo_metrics where computed_at < now() - interval '7 days'`,
      )
    ).rows[0];
    if (stale && stale.n > 0) console.log(`  stale >7d         ${stale.n}`);
  }

  const setup = (
    await pool.query<{ setup_weight: string; n: number }>(
      `select setup_weight, count(*)::int as n from setup_facts group by 1 order by n desc`,
    )
  ).rows;

  if (setup.length > 0) {
    const total = setup.reduce((sum, row) => sum + row.n, 0);
    console.log(`\nSetup facts\n  computed for      ${total} repos`);
    for (const row of setup) console.log(`  ${row.setup_weight.padEnd(16)} ${row.n}`);

    const agreements = (
      await pool.query<{ contributor_agreement: string | null; n: number }>(
        `select contributor_agreement, count(*)::int as n
           from setup_facts group by 1 order by n desc`,
      )
    ).rows;
    const measured = agreements.filter((row) => row.contributor_agreement !== null);
    if (measured.length > 0) {
      console.log('  contributor agreement');
      for (const row of measured) {
        console.log(`    ${(row.contributor_agreement ?? '').padEnd(14)} ${row.n}`);
      }
      const unmeasured = agreements.find((row) => row.contributor_agreement === null)?.n ?? 0;
      if (unmeasured > 0) {
        console.log(`    ${'unmeasured'.padEnd(14)} ${unmeasured} (no CONTRIBUTING file was readable)`);
      }
    }
    const truncated = (
      await pool.query<{ n: number }>('select count(*)::int as n from setup_facts where tree_truncated')
    ).rows[0];
    if (truncated && truncated.n > 0) {
      console.log(`  tree unread       ${truncated.n} (absence of a file proves nothing for these)`);
    }
  }

  /**
   * Star history exists so that velocity can exist later, and nothing reads it yet — which makes it
   * exactly the kind of work that gets rebuilt because nobody could tell it had happened. This line
   * is how you know the clock is running.
   */
  const stars = await starHistoryCoverage();
  if (stars.samples > 0) {
    console.log('\nStar history');
    console.log(`  samples           ${stars.samples} across ${stars.repos} repos`);
    console.log(
      stars.spanDays !== null && stars.spanDays >= 1
        ? `  spanning          ${stars.spanDays} days — velocity becomes measurable as this grows`
        : `  spanning          under a day — velocity needs samples weeks apart`,
    );
  }

  /**
   * Invariant: a merge IS a response, so merged_prs > 0 with responded_prs = 0 should only happen
   * when every merge was performed by automation. Anything else means a human merger was
   * misclassified as a bot — which is how an active project ends up reported as 100% ignored.
   */
  const suspect = (
    await pool.query<{ full_name: string; external_prs: number; merged_prs: number }>(`
      select r.full_name, m.external_prs, m.merged_prs
        from repo_metrics m
        join repos r on r.id = m.repo_id
       where m.merged_prs > 0
         and m.responded_prs = 0
         -- Paused repos are never recomputed, so their metrics are frozen and a violation here is
         -- historical rather than actionable.
         and r.sync_state = 'active'
       order by m.merged_prs desc
       limit 10`)
  ).rows;

  if (suspect.length > 0) {
    console.log('\nMerged but no recorded response  (a merge is attention — check these)');
    for (const row of suspect) {
      console.log(
        `  ${row.full_name.padEnd(40)} ${row.merged_prs} merged of ${row.external_prs} external`,
      );
    }
    console.log(
      '  Expected only for merge-queue automation. Otherwise a human merger was read as a bot:',
    );
    console.log('    npm run compass -- responders --repo <one of the above>');
  }

  const decisions = (
    await pool.query<{ verdict: string; n: number }>(
      `select verdict, count(*)::int as n from decisions group by verdict order by n desc`,
    )
  ).rows;
  if (decisions.length > 0) {
    console.log('\nDecisions journal');
    for (const row of decisions) console.log(`  ${row.verdict.padEnd(16)} ${row.n}`);
  }

  const runs = (
    await pool.query<RunRow>(`
      select id, kind, status, started_at,
             extract(epoch from (finished_at - started_at))::int as seconds,
             repos_upserted, issues_upserted, http_requests, http_not_modified,
             graphql_points,
             (rate_snapshot -> 'core' ->> 'limit')::int as core_limit,
             (rate_snapshot -> 'graphql' ->> 'limit')::int as graphql_limit,
             left(error, 160) as error,
             (detail ->> 'failedBatches')::int as failed_batches
        from sync_runs
       order by started_at desc
       limit 8`)
  ).rows;

  if (runs.length > 0) {
    console.log('\nRecent runs');
    for (const run of runs) {
      const billed = run.http_requests - run.http_not_modified;
      const cost =
        run.graphql_points > 0
          ? `${run.graphql_points}pts` +
            (run.graphql_limit ? ` (${((run.graphql_points / run.graphql_limit) * 100).toFixed(1)}%)` : '')
          : `${billed}req` +
            (run.core_limit ? ` (${((billed / run.core_limit) * 100).toFixed(1)}%)` : '');
      console.log(
        `  #${String(run.id).padEnd(4)} ${run.kind.padEnd(7)} ${run.status.padEnd(14)} ` +
          `${run.started_at.toISOString().slice(0, 16).replace('T', ' ')}  ` +
          `${String(run.seconds ?? '?').padStart(4)}s  ` +
          `repos:${String(run.repos_upserted).padStart(4)} issues:${String(run.issues_upserted).padStart(5)}  ` +
          `${cost}`,
      );
      if (run.failed_batches) console.log(`        ${run.failed_batches} batch failures`);
      if (run.error) console.log(`        ${run.error}`);
    }
  }
  console.log('');
}
