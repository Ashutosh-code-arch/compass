/**
 * Terminal output for the organisation table. Every value arrives already computed.
 *
 * This is the table nobody else can produce. Aggregators list issues carrying a label; the official
 * GSoC page gives a description and some technology tags. Neither can tell a student whether anyone
 * will read their pull request. The three middle columns are the whole point, and they are only
 * possible because the responsiveness engine already exists.
 */

import { formatHours } from '../rank/score.ts';
import { getOrgs } from './data.ts';
import { importGsocYear } from './import.ts';
import type { AssembleOrgsOptions, GsocOutlook, OrgFilters, OrgRow, OrgsView, OrgSort, SetupDistribution } from './view.ts';

const DASH = '—';

/** Truncates to a column width, marking that it happened. */
function fit(text: string, width: number): string {
  return text.length <= width ? text.padEnd(width) : `${text.slice(0, width - 1)}\u2026`;
}

/**
 * The verdict with its denominator, because a verdict from one repository is not a verdict about an
 * organisation.
 */
function attention(row: OrgRow): string {
  if (row.repos === 0) return 'not in corpus';
  if (row.responsiveness === null) return DASH;

  const reply =
    row.medianRepoHoursResponse === null ? DASH : formatHours(row.medianRepoHoursResponse);
  const share = row.measuredRepos > 1 ? ` ${row.agreeing}/${row.measuredRepos}` : '';
  return `${row.responsiveness}${share} · ${reply}`;
}

/**
 * A percentage with its denominator attached.
 *
 * `100%` from two decided pull requests and `74%` from three hundred are not the same claim, and this
 * is the only place the reader gets to notice.
 */
function mergeRate(row: OrgRow): string {
  if (row.mergeRate === null) return DASH;
  return `${Math.round(row.mergeRate * 100)}% of ${row.decidedPrs}`;
}

/** A distribution, compressed but never averaged. */
function setup(distribution: SetupDistribution): string {
  const parts: string[] = [];
  if (distribution.light > 0) parts.push(`${distribution.light} light`);
  if (distribution.moderate > 0) parts.push(`${distribution.moderate} mod`);
  if (distribution.heavy > 0) parts.push(`${distribution.heavy} heavy`);
  if (distribution.unknown > 0) parts.push(`${distribution.unknown} unk`);
  return parts.length === 0 ? DASH : parts.join(' ');
}

/** Contiguous years collapse to a range: 2024, 2025, 2026 reads as 2024–26. */
export function formatYears(years: number[]): string {
  if (years.length === 0) return '';
  const runs: number[][] = [];
  for (const year of years) {
    const last = runs.at(-1);
    if (last && year === last.at(-1)! + 1) last.push(year);
    else runs.push([year]);
  }
  return runs
    .map((run) =>
      run.length === 1
        ? String(run[0])
        : `${run[0]}\u2013${String(run.at(-1)).slice(2)}`,
    )
    .join(', ');
}

/**
 * Growth with its verdict, or a dash.
 *
 * A dash means velocity is unmeasured — fewer than two star samples a week or more apart — and NOT that
 * the organisation is not growing. That distinction is the reason `repo_stars_history` was created in
 * Phase 0 and left unread for two phases.
 */
function momentumCell(row: OrgRow): string {
  if (row.momentum === null) return DASH;
  const share = row.momentumRepos > 1 ? ` ${row.momentumRepos}` : '';
  const gained =
    row.starsGained === null ? '' : ` ${row.starsGained >= 0 ? '+' : ''}${row.starsGained}★`;
  return `${row.momentum}${share}${gained}`;
}

function calendarLine(outlook: GsocOutlook): string {
  return `GSoC: ${outlook.message}`;
}

export interface OrgsCommandOptions extends OrgFilters {
  sort?: OrgSort;
  limit?: number;
  offset?: number;
}

/** The organisation table. */
export async function orgs(options: OrgsCommandOptions = {}): Promise<void> {
  const { sort, limit, offset, ...filters } = options;
  const view = await getOrgs({
    ...(sort === undefined ? {} : { sort }),
    ...(limit === undefined ? {} : { limit }),
    ...(offset === undefined ? {} : { offset }),
    filters,
  } satisfies AssembleOrgsOptions);
  renderOrgs(view);
}

/** Imports a curated GSoC year list. */
export async function gsocImport(
  path: string,
  year: number,
  source: string,
  replace: boolean,
): Promise<void> {
  renderGsocImport(await importGsocYear({ path, year, source, replace }));
}

export function renderOrgs(view: OrgsView): void {
  const { summary, rows } = view;

  if (rows.length === 0) {
    console.log('No organisations matched.');
    console.log(
      summary.organizations === 0
        ? 'The organizations table is empty. It fills from `seed`, `sync repos`, `add`, or `gsoc import`.'
        : `${summary.organizations} organisation(s) exist; the filters excluded all of them.`,
    );
    return;
  }

  console.log(
    `${summary.shown} of ${summary.organizations} organisations, ` +
      `${summary.openCandidates.toLocaleString()} open candidates between them.\n`,
  );

  const header =
    `${fit('Organisation', 22)}  ${fit('Maintainers reply?', 24)}  ${fit('Merge rate', 14)}  ` +
    `${fit('Momentum', 18)}  ${fit('Open', 6)}  GSoC`;
  console.log(header);
  console.log('\u2500'.repeat(header.length));

  for (const row of rows) {
    console.log(
      `${fit(row.login, 22)}  ${fit(attention(row), 24)}  ${fit(mergeRate(row), 14)}  ` +
        `${fit(momentumCell(row), 18)}  ${fit(String(row.openCandidates), 6)}  ` +
        formatYears(row.gsocYears),
    );
    // Setup moves to a detail line to make room: momentum is the newer and more decisive column, and a
    // distribution never fitted a fixed width honestly anyway.
    if (row.repos > 0) {
      console.log(`${' '.repeat(24)}setup ${setup(row.setup)}`);
    }

    // Paperwork is usually an organisation-wide fact, which makes this the right level to raise it.
    if (row.claRepos > 0) {
      console.log(
        `${' '.repeat(26)}CLA in ${row.claRepos} of ${row.repos} repos — resolve before writing code`,
      );
    }
  }

  console.log(
    `\nVerdicts are the most common across an organisation's MEASURED repositories, with the count ` +
      `shown.\nMerge rate is pooled across repositories, not averaged, so a busy repo outweighs a ` +
      `quiet one.\nSetup is a distribution: these are ordinals and averaging them would invent a ` +
      `number.\nMomentum crosses growth with review capacity — "hype" means surging AND nobody can ` +
      `read the result.\nA dash means unmeasured, never zero.`,
  );

  // The uncovered and unmeasured counts arrive as notices, which the API returns too. Printing them
  // again here would say the same thing twice in slightly different words.
  for (const notice of view.notices) console.log(`\n${notice}`);

  if (summary.uncovered > 0) {
    console.log(`  npm run compass -- orgs --uncovered`);
  }

  console.log(`\n${calendarLine(view.gsoc)}`);
  console.log('Drill into one:  npm run compass -- shortlist --org <login>');
}

export function renderGsocImport(result: {
  year: number;
  logins: number;
  rejected: number;
  created: number;
  uncovered: number;
  removed: number;
}): void {
  console.log(
    `GSoC ${result.year}: ${result.logins} organisation(s) tagged` +
      (result.removed > 0 ? `, ${result.removed} earlier tag(s) replaced` : '') +
      '.',
  );
  if (result.created > 0) {
    console.log(`${result.created} organisation(s) were new to the corpus and now exist as rows.`);
  }
  if (result.rejected > 0) {
    console.log(
      `${result.rejected} line(s) did not parse as GitHub logins and were skipped. GSoC publishes ` +
        `programme names, not logins — those have to be mapped by hand.`,
    );
  }
  if (result.uncovered > 0) {
    console.log(
      `\n${result.uncovered} of them have no repositories in your corpus, so nothing about them is ` +
        `measured yet. That list is the point of the import:\n` +
        `  npm run compass -- orgs --gsoc ${result.year} --uncovered\n` +
        `  npm run compass -- add owner/name    # then sync metrics`,
    );
  }
}
