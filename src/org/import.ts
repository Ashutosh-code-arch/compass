/**
 * Writing a curated GSoC organisation list into `org_tags`.
 *
 * Every row written carries `reviewed_at` and `source`, because a curated value without a date and a
 * provenance is indistinguishable from a measurement, and it is the one that goes stale silently.
 */

import { readFileSync } from 'node:fs';
import { db } from '../db.ts';
import { assertUsableOrgList, parseOrgList } from './gsoc.ts';

export interface GsocImportOptions {
  path: string;
  year: number;
  /** Where the list came from. Required by the CLI, not defaulted. */
  source: string;
  /**
   * Remove this year's existing tags first.
   *
   * Only safe because the list is validated before anything is deleted: a `--replace` driven by a
   * file that turned out to be empty would erase a year's curation on the strength of a failed
   * download.
   */
  replace?: boolean;
  /** Today, as the review date. Injected so the writer is testable. */
  reviewedAt?: string;
}

export interface GsocImportResult {
  year: number;
  logins: number;
  rejected: number;
  /** Organisations that did not previously exist at all. */
  created: number;
  /** Of the imported organisations, how many have no repositories in the corpus. */
  uncovered: number;
  removed: number;
}

/**
 * Imports a list of logins as `gsoc_year` tags.
 *
 * Organisations absent from the corpus are CREATED as identity-only rows rather than skipped. A GSoC
 * organisation you have never measured is the most useful output the import has — it is the list to
 * run `add` against — and dropping those rows would leave the wedge table quietly describing only the
 * organisations you already happened to discover.
 */
export async function importGsocYear(options: GsocImportOptions): Promise<GsocImportResult> {
  const parsed = parseOrgList(readFileSync(options.path, 'utf8'));
  assertUsableOrgList(parsed, options.path);

  const reviewedAt = options.reviewedAt ?? new Date().toISOString().slice(0, 10);
  const year = String(options.year);
  const pool = db();
  const client = await pool.connect();

  try {
    await client.query('begin');

    let removed = 0;
    if (options.replace === true) {
      const deleted = await client.query(
        `delete from org_tags where kind = 'gsoc_year' and value = $1`,
        [year],
      );
      removed = deleted.rowCount ?? 0;
    }

    // Identity rows first: org_tags has a foreign key, and the point is to keep the ones with no
    // repositories rather than lose them to it.
    const created = await client.query(
      `insert into organizations (login)
       select unnest($1::text[])
       on conflict (login) do nothing`,
      [parsed.logins],
    );

    await client.query(
      `insert into org_tags (org_login, kind, value, source, reviewed_at)
       select unnest($1::text[]), 'gsoc_year', $2, $3, $4::date
       on conflict (org_login, kind, value)
         -- Re-importing the same year refreshes the review date and the source. That is the point of
         -- re-importing: the claim has been checked again today.
         do update set source = excluded.source, reviewed_at = excluded.reviewed_at`,
      [parsed.logins, year, options.source, reviewedAt],
    );

    const uncovered = (
      await client.query<{ n: string }>(
        `select count(*)::text as n
           from organizations o
          where o.login = any($1::text[])
            and not exists (
              select 1 from repos r where r.owner = o.login and r.sync_state <> 'gone'
            )`,
        [parsed.logins],
      )
    ).rows[0]!.n;

    await client.query('commit');

    return {
      year: options.year,
      logins: parsed.logins.length,
      rejected: parsed.rejected.length,
      created: created.rowCount ?? 0,
      uncovered: Number(uncovered),
      removed,
    };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
