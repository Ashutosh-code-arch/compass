/**
 * Writing a ROSS Index dataset into `org_tags`.
 *
 * Curated rows only: `ross_quarter` (who was on the list) and `funding`. Growth is deliberately NOT
 * imported — Compass measures that itself from `repo_stars_history`, and storing somebody else's growth
 * figure beside its own would create two numbers for one question with no way to tell which a reader was
 * looking at.
 */

import { readFileSync } from 'node:fs';
import { db } from '../db.ts';
import { parseRossCsv, type RossRow } from './ross.ts';

export interface RossImportOptions {
  path: string;
  /** The dataset's quarter, e.g. "2026Q1". Required: an undated curated list is the thing to avoid. */
  quarter: string;
  source: string;
  reviewedAt?: string;
}

export interface RossImportResult {
  quarter: string;
  rows: number;
  rejected: number;
  createdOrgs: number;
  fundingTags: number;
  /** Repositories named by the dataset that are not in the corpus — the list to run `add` against. */
  missingRepos: string[];
  columns: Record<string, string>;
}

export async function importRoss(options: RossImportOptions): Promise<RossImportResult> {
  const parsed = parseRossCsv(readFileSync(options.path, 'utf8'));
  const reviewedAt = options.reviewedAt ?? new Date().toISOString().slice(0, 10);
  const logins = parsed.rows.map((row) => row.login);

  const client = await db().connect();
  try {
    await client.query('begin');

    const created = await client.query(
      `insert into organizations (login) select unnest($1::text[]) on conflict (login) do nothing`,
      [logins],
    );

    await client.query(
      `insert into org_tags (org_login, kind, value, source, reviewed_at)
       select unnest($1::text[]), 'ross_quarter', $2, $3, $4::date
       on conflict (org_login, kind, value)
         do update set source = excluded.source, reviewed_at = excluded.reviewed_at`,
      [logins, options.quarter, options.source, reviewedAt],
    );

    const funded = parsed.rows.filter(
      (row): row is RossRow & { funding: string } => row.funding !== null,
    );
    if (funded.length > 0) {
      await client.query(
        // Columns named explicitly. The first version used `select *` over a join and silently put the
        // funding value into `kind` — caught only because migration 010's CHECK constraint rejected it.
        // Positional column matching is the same mistake this module's own parser refuses to make.
        `insert into org_tags (org_login, kind, value, source, reviewed_at)
         select t.login, 'funding', t.funding, $3, $4::date
           from unnest($1::text[], $2::text[]) as t(login, funding)
         on conflict (org_login, kind, value)
           do update set source = excluded.source, reviewed_at = excluded.reviewed_at`,
        [
          funded.map((row) => row.login),
          funded.map((row) => row.funding),
          options.source,
          reviewedAt,
        ],
      );
    }

    // Which named repositories are absent. The most actionable output the import has.
    const named = parsed.rows
      .map((row) => row.repoFullName)
      .filter((name): name is string => name !== null);
    const missing =
      named.length === 0
        ? []
        : (
            await client.query<{ name: string }>(
              `select n as name
                 from unnest($1::text[]) as n
                where not exists (select 1 from repos r where lower(r.full_name) = lower(n))`,
              [named],
            )
          ).rows.map((row) => row.name);

    await client.query('commit');

    return {
      quarter: options.quarter,
      rows: parsed.rows.length,
      rejected: parsed.rejected.length,
      createdOrgs: created.rowCount ?? 0,
      fundingTags: funded.length,
      missingRepos: missing,
      columns: parsed.columns,
    };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export function renderRossImport(result: RossImportResult): void {
  console.log(
    `ROSS ${result.quarter}: ${result.rows} organisation(s) tagged` +
      (result.fundingTags > 0 ? `, ${result.fundingTags} with funding recorded` : '') +
      '.',
  );
  console.log(
    `Columns read: ${Object.entries(result.columns)
      .map(([field, header]) => `${field}="${header}"`)
      .join(', ')}`,
  );
  if (result.createdOrgs > 0) {
    console.log(`${result.createdOrgs} organisation(s) were new to the corpus and now exist as rows.`);
  }
  if (result.rejected > 0) {
    console.log(`${result.rejected} row(s) had no usable owner and were skipped.`);
  }
  if (result.missingRepos.length > 0) {
    console.log(
      `\n${result.missingRepos.length} repository(ies) on the list are not in your corpus. Growth is ` +
        `measured from your own star history, so these contribute nothing until they are added:`,
    );
    for (const name of result.missingRepos.slice(0, 10)) {
      console.log(`  npm run compass -- add ${name}`);
    }
    if (result.missingRepos.length > 10) {
      console.log(`  …and ${result.missingRepos.length - 10} more`);
    }
  }
  console.log(
    `\nEverything imported is CURATED — somebody else's numbers on their date. Growth itself stays ` +
      `measured from repo_stars_history.`,
  );
}

export async function rossImport(path: string, quarter: string, source: string): Promise<void> {
  renderRossImport(await importRoss({ path, quarter, source }));
}
