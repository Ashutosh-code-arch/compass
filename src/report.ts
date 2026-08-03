import { db } from './db.ts';

export type MaintainerSort = 'median' | 'ignored' | 'stale' | 'reviewed' | 'merge';

export interface MaintainersOptions {
  sort?: MaintainerSort;
  limit?: number;
  /** Hide rows whose sample is too small to mean anything. */
  minExternalPrs?: number;
  /** Show only one responsiveness bucket. */
  bucket?: string;
}

interface Row {
  full_name: string;
  stars: number;
  responsiveness: string;
  confidence: string;
  external_prs: number;
  responded_prs: number;
  median_hours_response: string | null;
  no_response_rate: string | null;
  merge_rate: string | null;
  changes_requested_rate: string | null;
  open_stale_rate: string | null;
  too_recent_prs: number;
  decidable_prs: number;
  hours_since_last_action: string | null;
  computed_at: Date;
}

const ORDER_BY: Record<MaintainerSort, string> = {
  median: 'm.median_hours_response asc nulls last',
  ignored: 'm.no_response_rate desc nulls last',
  stale: 'm.open_stale_rate desc nulls last',
  reviewed: 'm.hours_since_last_action asc nulls last',
  merge: 'm.merge_rate desc nulls last',
};

function days(hours: string | null): string {
  if (hours === null) return '—';
  const value = Number(hours);
  if (value < 48) return `${value.toFixed(0)}h`;
  return `${(value / 24).toFixed(0)}d`;
}

function pct(rate: string | null): string {
  return rate === null ? '—' : `${Math.round(Number(rate) * 100)}%`;
}

export async function maintainers(options: MaintainersOptions = {}): Promise<void> {
  const sort = options.sort ?? 'median';
  // n=1 rows at 100% ignored are noise; pass --min-prs 0 to see everything.
  const minExternal = options.minExternalPrs ?? 3;

  const rows = (
    await db().query<Row>(
      `select r.full_name, r.stars,
              m.responsiveness, m.confidence, m.external_prs, m.responded_prs,
              m.median_hours_response, m.no_response_rate, m.merge_rate,
              m.changes_requested_rate, m.open_stale_rate, m.hours_since_last_action,
              m.too_recent_prs, m.decidable_prs, m.computed_at
         from repo_metrics m
         join repos r on r.id = m.repo_id
        where m.external_prs >= $1
          and ($2::text is null or m.responsiveness = $2)
        order by ${ORDER_BY[sort]}
        limit $3`,
      [minExternal, options.bucket ?? null, options.limit ?? 40],
    )
  ).rows;

  if (rows.length === 0) {
    console.log('\nNo metrics yet. Run: npm run compass -- sync metrics\n');
    return;
  }

  const width = Math.min(38, Math.max(...rows.map((row) => row.full_name.length)));
  console.log(
    `\n${'repository'.padEnd(width)}  ${'bucket'.padEnd(10)} ${'conf'.padEnd(6)} ` +
      `${'n'.padStart(3)} ${'resp'.padStart(5)} ${'median'.padStart(7)} ${'ignored'.padStart(8)} ` +
      `${'merged'.padStart(7)} ${'chg-req'.padStart(8)} ${'stalled'.padStart(8)} ${'last rev'.padStart(9)}`,
  );
  console.log('-'.repeat(width + 78));

  for (const row of rows) {
    console.log(
      `${row.full_name.slice(0, width).padEnd(width)}  ` +
        `${row.responsiveness.padEnd(10)} ${row.confidence.padEnd(6)} ` +
        `${String(row.external_prs).padStart(3)} ` +
        `${String(row.responded_prs).padStart(5)} ` +
        `${days(row.median_hours_response).padStart(7)} ` +
        `${pct(row.no_response_rate).padStart(8)} ` +
        `${pct(row.merge_rate).padStart(7)} ` +
        `${pct(row.changes_requested_rate).padStart(8)} ` +
        `${pct(row.open_stale_rate).padStart(8)} ` +
        `${days(row.hours_since_last_action).padStart(9)}`,
    );
  }

  console.log(
    `\nsorted by ${sort}. ` +
      `median = hours over the "resp" responded PRs only, not all n — ` +
      `a 0h median on resp=1 is one data point, not a fast project.`,
  );
  console.log(
    `conf=low means fewer than 5 external PRs: treat those rows as anecdote, not measurement.\n`,
  );
}

/**
 * Who is actually answering external PRs across the whole corpus, and how fast.
 *
 * This exists because bot accounts that are ordinary users with a MEMBER association are
 * indistinguishable from maintainers at the API level. They are obvious here: dozens or hundreds of
 * responses at a near-zero median across many repos is a welcome bot, not a person. Add those
 * logins to COMPASS_IGNORE_LOGINS and recompute.
 */
export async function responders(limit = 30, repo?: string): Promise<void> {
  const rows = (
    await db().query<{
      responder: string;
      association: string | null;
      responses: number;
      repos: number;
      median_hours: string | null;
      instant_share: string | null;
    }>(
      `select p->>'responseBy'                                   as responder,
              mode() within group (order by p->>'responseAssociation') as association,
              count(*)::int                                      as responses,
              count(distinct m.repo_id)::int                     as repos,
              percentile_cont(0.5) within group (
                order by (p->>'responseHours')::numeric)         as median_hours,
              avg(case when (p->>'responseHours')::numeric <= 0.25 then 1 else 0 end) as instant_share
         from repo_metrics m
         join repos r on r.id = m.repo_id,
              jsonb_array_elements(m.detail->'perPr') p
        where p->>'responseBy' is not null
          and p->>'responseHours' is not null
          and ($2::text is null or r.full_name = $2)
        group by 1
        order by responses desc
        limit $1`,
      [limit, repo ?? null],
    )
  ).rows;

  if (rows.length === 0) {
    console.log('\nNo responder data yet. Run: npm run compass -- sync metrics\n');
    return;
  }

  const width = Math.min(32, Math.max(...rows.map((row) => row.responder.length), 9));
  console.log(
    `\n${'responder'.padEnd(width)}  ${'assoc'.padEnd(12)} ${'resp'.padStart(5)} ${'repos'.padStart(6)} ` +
      `${'median'.padStart(8)} ${'<15min'.padStart(7)}  flag`,
  );
  console.log('-'.repeat(width + 46));

  for (const row of rows) {
    const medianHours = row.median_hours === null ? null : Number(row.median_hours);
    const instant = row.instant_share === null ? 0 : Number(row.instant_share);
    // Automation is fast on nearly everything, or fast on essentially all of it. Either shape is
    // worth a look; the median is the more robust of the two signals.
    const suspect =
      row.responses >= 3 && (instant >= 0.6 || (medianHours !== null && medianHours <= 0.25));
    console.log(
      `${row.responder.slice(0, width).padEnd(width)}  ` +
        `${(row.association ?? '—').padEnd(12)} ` +
        `${String(row.responses).padStart(5)} ` +
        `${String(row.repos).padStart(6)} ` +
        `${(medianHours === null ? '—' : medianHours < 48 ? `${medianHours.toFixed(1)}h` : `${(medianHours / 24).toFixed(0)}d`).padStart(8)} ` +
        `${`${Math.round(instant * 100)}%`.padStart(7)}  ` +
        `${suspect ? 'likely bot' : ''}`,
    );
  }

  const suspects = rows
    .filter(
      (row) =>
        row.responses >= 3 &&
        (Number(row.instant_share ?? 0) >= 0.6 ||
          (row.median_hours !== null && Number(row.median_hours) <= 0.25)),
    )
    .map((row) => row.responder.toLowerCase());

  if (suspects.length > 0) {
    console.log(
      `\nAdd suspected automation to .env and recompute:\n` +
        `  COMPASS_IGNORE_LOGINS=${suspects.join(',')}\n` +
        `  npm run compass -- sync metrics --stale-days 0 --limit 2000\n`,
    );
  } else {
    console.log('\nNo obvious automation among first-responders.\n');
  }
}
export async function explainRepo(fullName: string): Promise<void> {
  const result = await db().query<{
    full_name: string;
    responsiveness: string;
    confidence: string;
    external_prs: number;
    insider_prs: number;
    bot_prs: number;
    median_hours_response: string | null;
    no_response_rate: string | null;
    too_recent_prs: number;
    decidable_prs: number;
    detail: {
      maintainersKnown?: number;
      perPr?: {
        number: number; createdAt: string; outcome: string; responseHours: number | null;
        responseBy: string | null; responseAssociation: string | null;
        changesRequested: boolean; stalled: boolean; tooRecent?: boolean;
      }[];
    };
  }>(
    `select r.full_name, m.responsiveness, m.confidence, m.external_prs, m.insider_prs,
            m.bot_prs, m.median_hours_response, m.no_response_rate,
            m.too_recent_prs, m.decidable_prs, m.detail
       from repo_metrics m join repos r on r.id = m.repo_id
      where r.full_name = $1`,
    [fullName],
  );

  const row = result.rows[0];
  if (!row) {
    console.log(`\nNo metrics for ${fullName}. Run: npm run compass -- sync metrics --repo ${fullName}\n`);
    return;
  }

  console.log(`\n${row.full_name} — ${row.responsiveness} (confidence: ${row.confidence})`);
  console.log(
    `sample: ${row.external_prs} external, ${row.insider_prs} insider, ${row.bot_prs} bot PRs discarded`,
  );
  if (row.detail.maintainersKnown !== undefined) {
    console.log(
      `maintainers identified: ${row.detail.maintainersKnown}` +
        (row.detail.maintainersKnown === 0
          ? '  <-- none found, so no response could be attributed'
          : ''),
    );
  }
  console.log(
    `median response ${days(row.median_hours_response)}, ` +
      `ignored ${pct(row.no_response_rate)} of ${row.decidable_prs} decidable ` +
      `(${row.too_recent_prs} too recent to judge)\n`,
  );

  const perPr = row.detail.perPr ?? [];
  if (perPr.length === 0) {
    console.log('No external PRs in the window.\n');
    return;
  }

  console.log(`${'PR'.padStart(7)}  ${'opened'.padEnd(10)} ${'outcome'.padEnd(15)} ${'response'.padStart(9)}  responder`);
  console.log('-'.repeat(70));
  for (const pr of perPr) {
    const response =
      pr.responseHours === null
        ? pr.stalled
          ? 'stalled'
          : pr.tooRecent
            ? 'too recent'
            : 'none yet'
        : pr.responseHours < 48
          ? `${pr.responseHours.toFixed(0)}h`
          : `${(pr.responseHours / 24).toFixed(0)}d`;
    const responder = pr.responseBy
      ? `${pr.responseBy} (${pr.responseAssociation})${pr.changesRequested ? ' [changes requested]' : ''}`
      : '';
    console.log(
      `${String(pr.number).padStart(7)}  ${pr.createdAt.slice(0, 10)} ${pr.outcome.padEnd(15)} ` +
        `${response.padStart(9)}  ${responder}`,
    );
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Setup facts (Slice 3)
// ---------------------------------------------------------------------------

export type SetupSort = 'weight' | 'services' | 'env' | 'runtime';

export interface SetupReportOptions {
  sort?: SetupSort;
  limit?: number;
  weight?: string;
  /** Hide anything declaring more than this many compose services. */
  maxServices?: number;
}

const SETUP_ORDER: Record<SetupSort, string> = {
  // Ordinal, so sort by explicit rank rather than alphabetically.
  weight: `case f.setup_weight when 'light' then 1 when 'moderate' then 2
             when 'heavy' then 3 else 4 end asc, f.compose_services asc nulls first`,
  services: 'f.compose_services asc nulls first',
  env: 'f.env_var_count asc nulls first',
  runtime: 'jsonb_array_length(f.runtimes) asc',
};

interface SetupRow {
  full_name: string;
  setup_weight: string;
  compose_services: number | null;
  env_var_count: number | null;
  external_services: string[];
  runtimes: { name: string; constraint: string }[];
  has_devcontainer: boolean;
  task_runner: string;
  has_contributing: boolean;
  ci_runs_on_pr: boolean | null;
  is_monorepo: boolean;
  tree_truncated: boolean;
  responsiveness: string | null;
}

export async function setupReport(options: SetupReportOptions = {}): Promise<void> {
  const sort = options.sort ?? 'weight';

  const rows = (
    await db().query<SetupRow>(
      `select r.full_name, f.setup_weight, f.compose_services, f.env_var_count,
              f.external_services, f.runtimes, f.has_devcontainer, f.task_runner,
              f.has_contributing, f.ci_runs_on_pr, f.is_monorepo, f.tree_truncated,
              m.responsiveness
         from setup_facts f
         join repos r on r.id = f.repo_id
         left join repo_metrics m on m.repo_id = f.repo_id
        where ($1::text is null or f.setup_weight = $1)
          and ($2::int is null or coalesce(f.compose_services, 0) <= $2)
        order by ${SETUP_ORDER[sort]}
        limit $3`,
      [options.weight ?? null, options.maxServices ?? null, options.limit ?? 40],
    )
  ).rows;

  if (rows.length === 0) {
    console.log('\nNo setup facts yet. Run: npm run compass -- sync setup\n');
    return;
  }

  const width = Math.min(38, Math.max(...rows.map((row) => row.full_name.length)));
  const RUNTIME_W = 26;
  const SERVICES_W = 24;
  const MITIGATION_W = 20;

  /** Truncating mid-word reads as a rendering bug; drop whole items and mark the elision. */
  const joinFitting = (items: string[], limit: number): string => {
    const kept: string[] = [];
    let length = 0;
    for (const item of items) {
      const cost = item.length + (kept.length > 0 ? 1 : 0);
      if (length + cost > limit) return `${kept.join(' ')}${kept.length > 0 ? ' +' : ''}`;
      kept.push(item);
      length += cost;
    }
    return kept.join(' ');
  };

  console.log(
    `\n${'repository'.padEnd(width)}  ${'weight'.padEnd(9)} ${'svcs'.padStart(4)} ${'env'.padStart(4)} ` +
      `${'runtimes'.padEnd(RUNTIME_W)} ${'backing services'.padEnd(SERVICES_W)} ` +
      `${'has'.padEnd(MITIGATION_W)} maintainers`,
  );
  console.log('-'.repeat(width + RUNTIME_W + SERVICES_W + MITIGATION_W + 34));

  for (const row of rows) {
    const runtime = joinFitting(
      row.runtimes.map((entry) => `${entry.name}${entry.constraint ? ` ${entry.constraint}` : ''}`),
      RUNTIME_W,
    );
    const services = joinFitting(row.external_services, SERVICES_W);

    // Reported alongside the weight, never folded into it: "heavy but one command to start" and
    // "heavy with no documented path in" are different situations. Abbreviated so the column fits
    // without cutting words in half.
    const mitigations = joinFitting(
      [
        row.has_devcontainer ? 'devcontainer' : null,
        row.task_runner !== 'none' ? row.task_runner : null,
        row.has_contributing ? 'docs' : null,
        row.ci_runs_on_pr === true ? 'ci-pr' : null,
        row.is_monorepo ? 'monorepo' : null,
      ].filter((entry): entry is string => entry !== null),
      MITIGATION_W,
    );

    console.log(
      `${row.full_name.slice(0, width).padEnd(width)}  ` +
        `${row.setup_weight.padEnd(9)} ` +
        `${(row.compose_services === null ? '—' : String(row.compose_services)).padStart(4)} ` +
        `${(row.env_var_count === null ? '—' : String(row.env_var_count)).padStart(4)} ` +
        `${runtime.padEnd(RUNTIME_W)} ${services.padEnd(SERVICES_W)} ${mitigations.padEnd(MITIGATION_W)} ` +
        `${row.responsiveness ?? '—'}${row.tree_truncated ? '  [tree unread]' : ''}`,
    );
  }

  console.log(
    `\nsorted by ${sort}. svcs = declared compose services, env = variables in the env template. ` +
      `"—" means the file was absent, not that the count is zero.`,
  );
  console.log(
    `"has" is reported separately from weight on purpose — a heavy project with a devcontainer is a ` +
      `different proposition from a heavy one without. A trailing "+" means the list was elided.`,
  );
  console.log(
    `Only ROOT-level files are read, so a compose file under docker/ or server/ reads as absent — ` +
      `which understates large monorepos.\n`,
  );
}
