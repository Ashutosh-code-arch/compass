/**
 * The organisation layer's foundation: keeping `organizations` in step with the corpus.
 *
 * Deliberately thin. An organisation row is identity and nothing else, so this is one statement over
 * data already stored and costs no API requests. Everything measured about an organisation is a
 * rollup over its repositories, computed on read in Phase 1 — a stored rollup is a number that can
 * disagree with the metrics it claims to summarise, and nothing in this project is allowed to do
 * that.
 */

import { db } from '../db.ts';

/**
 * The curated claim kinds, mirroring the CHECK constraint in migration 010.
 *
 * A `sync/orgs.test.ts` guard asserts the two agree. `RUN_KINDS` and the `sync_runs` CHECK drifted
 * once and every setup run died on its first insert, so a union in TypeScript and a constraint in SQL
 * now get checked against each other rather than trusted.
 */
export const ORG_TAG_KINDS = ['gsoc_year', 'funding', 'ross_quarter', 'market', 'note'] as const;

export type OrgTagKind = (typeof ORG_TAG_KINDS)[number];

export function isOrgTagKind(value: string): value is OrgTagKind {
  return (ORG_TAG_KINDS as readonly string[]).includes(value);
}

/**
 * Ensures an `organizations` row exists for every owner in the corpus.
 *
 * Called at the end of the paths that can introduce a new owner — seed, `sync repos`, and `add`.
 * Existing rows are untouched, so `first_seen_at` keeps meaning first sighting rather than most
 * recent sync.
 *
 * Rows are never deleted here. An organisation whose last repository was pruned still carries any
 * curated tags a human recorded against it, and losing a reviewed GSoC list because a repository
 * went dormant would be a bad trade.
 */
export async function refreshOrganizations(): Promise<number> {
  const result = await db().query(
    `insert into organizations (login, first_seen_at)
     select owner, min(discovered_at)
       from repos
      group by owner
     on conflict (login) do nothing`,
  );
  return result.rowCount ?? 0;
}
