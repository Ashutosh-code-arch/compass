import { db } from './db.ts';

export interface PruneOptions {
  /** Without this, nothing is written. Dry run is the default on purpose. */
  apply?: boolean;
  /** Pause repos whose maintainers look dormant. */
  dormant?: boolean;
  /** Pause repos whose setup cost is heavy. */
  heavy?: boolean;
  /** Minimum metric confidence before a dormant verdict is allowed to pause a repo. */
  minConfidence?: string;
  /** Restore every paused repo to active. */
  unpause?: boolean;
}

interface PruneRow {
  id: number;
  full_name: string;
  stars: number;
  responsiveness: string | null;
  confidence: string | null;
  external_prs: number | null;
  setup_weight: string | null;
  compose_services: number | null;
  issue_count: number;
  reason: string;
}

/** Measured from a real run: ~3 REST requests per repo to backfill open issues. */
const REQUESTS_PER_REPO = 3;
const HOURLY_CORE_BUDGET = 5000;

/**
 * Pausing is the cheap half of the whole exercise. Issue backfill costs roughly three requests per
 * repo, so a corpus of a thousand repos is most of an hour's budget and a quarter of a million rows —
 * and Slices 2 and 3 exist precisely to tell you which of those repos you would never contribute to.
 *
 * Reversible by design: `sync_state = 'paused'` stops issue and metric syncing without deleting
 * anything, and `--unpause` restores the lot.
 */
export async function prune(options: PruneOptions = {}): Promise<void> {
  const pool = db();

  if (options.unpause) {
    if (!options.apply) {
      const count = (
        await pool.query<{ n: number }>(
          `select count(*)::int as n from repos where sync_state = 'paused'`,
        )
      ).rows[0];
      console.log(`\nWould restore ${count?.n ?? 0} paused repos to active. Add --apply.\n`);
      return;
    }
    const result = await pool.query(
      `update repos set sync_state = 'active', sync_error = null, sync_error_count = 0
        where sync_state = 'paused'`,
    );
    console.log(`\nRestored ${result.rowCount ?? 0} repos to active.\n`);
    return;
  }

  const dormant = options.dormant ?? true;
  const heavy = options.heavy ?? false;
  const confidences = options.minConfidence === 'high' ? ['high'] : ['medium', 'high'];

  if (!dormant && !heavy) {
    console.log('\nNothing selected. Use --dormant and/or --heavy.\n');
    return;
  }

  const rows = (
    await pool.query<PruneRow>(
      `select r.id, r.full_name, r.stars,
              m.responsiveness, m.confidence, m.external_prs,
              f.setup_weight, f.compose_services,
              (select count(*)::int from issues i where i.repo_id = r.id) as issue_count,
              case
                when $1::boolean and m.responsiveness = 'dormant' then 'dormant maintainers'
                else 'heavy setup'
              end as reason
         from repos r
         left join repo_metrics m on m.repo_id = r.id
         left join setup_facts  f on f.repo_id = r.id
        where r.sync_state = 'active'
          and (
            ($1::boolean and m.responsiveness = 'dormant' and m.confidence = any($2::text[]))
            or ($3::boolean and f.setup_weight = 'heavy')
          )
          -- Never pause a repo you have live work in.
          and not exists (
            select 1 from decisions d
              join issues i on i.id = d.issue_id
             where i.repo_id = r.id
               and d.verdict in ('shortlisted', 'started', 'submitted')
          )
        order by r.stars desc`,
      [dormant, confidences, heavy],
    )
  ).rows;

  const totals = (
    await pool.query<{ active: number; unbackfilled: number }>(
      `select count(*)::int as active,
              count(*) filter (where not issues_backfilled)::int as unbackfilled
         from repos where sync_state = 'active'`,
    )
  ).rows[0];

  if (rows.length === 0) {
    console.log(
      `\nNothing to prune. ${totals?.active ?? 0} repos active, ` +
        `${totals?.unbackfilled ?? 0} still needing an issue backfill.\n` +
        `A dormant verdict only prunes at confidence ${confidences.join(' or ')} — ` +
        `run sync metrics on more of the corpus first.\n`,
    );
    return;
  }

  const width = Math.min(40, Math.max(...rows.map((row) => row.full_name.length)));
  console.log(
    `\n${options.apply ? 'Pausing' : 'Would pause'} ${rows.length} repos:\n`,
  );
  console.log(
    `${'repository'.padEnd(width)}  ${'reason'.padEnd(20)} ${'stars'.padStart(7)} ` +
      `${'n'.padStart(4)} ${'conf'.padEnd(7)} ${'setup'.padEnd(9)} issues held`,
  );
  console.log('-'.repeat(width + 60));

  for (const row of rows.slice(0, 40)) {
    console.log(
      `${row.full_name.slice(0, width).padEnd(width)}  ${row.reason.padEnd(20)} ` +
        `${row.stars.toLocaleString().padStart(7)} ` +
        `${String(row.external_prs ?? '—').padStart(4)} ` +
        `${(row.confidence ?? '—').padEnd(7)} ` +
        `${(row.setup_weight ?? '—').padEnd(9)} ` +
        `${row.issue_count}`,
    );
  }
  if (rows.length > 40) console.log(`... and ${rows.length - 40} more`);

  const remaining = (totals?.active ?? 0) - rows.length;
  const beforeRequests = (totals?.unbackfilled ?? 0) * REQUESTS_PER_REPO;
  const afterRequests = Math.max(0, (totals?.unbackfilled ?? 0) - rows.length) * REQUESTS_PER_REPO;

  console.log(
    `\n${remaining} repos would remain active (from ${totals?.active ?? 0}).`,
  );
  console.log(
    `Issue backfill cost: ~${beforeRequests} requests ` +
      `(${((beforeRequests / HOURLY_CORE_BUDGET) * 100).toFixed(0)}% of hourly core) ` +
      `becomes ~${afterRequests} (${((afterRequests / HOURLY_CORE_BUDGET) * 100).toFixed(0)}%).`,
  );

  if (!options.apply) {
    console.log(
      `\nDry run. Nothing written. Re-run with --apply, and note that --unpause reverses it.\n`,
    );
    return;
  }

  const result = await pool.query(
    `update repos set sync_state = 'paused' where id = any($1::bigint[])`,
    [rows.map((row) => row.id)],
  );
  console.log(`\nPaused ${result.rowCount ?? 0} repos. Reverse with: prune --unpause --apply\n`);
}
