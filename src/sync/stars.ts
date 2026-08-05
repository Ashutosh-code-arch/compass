/**
 * Star observations, one per repository per UTC day.
 *
 * Nothing reads this yet. It exists because velocity is the one signal in the roadmap that cannot be
 * built on demand: it needs samples separated by weeks, so the writing has to start long before the
 * reading. The cost is one statement per few hundred repositories on syncs that were happening
 * anyway, and zero additional API requests -- every caller here already has the star count in hand.
 *
 * `bucketToUtcDay` is PURE and is the only place the resolution is decided.
 */

import { bulkUpsert, db } from '../db.ts';

export interface StarSample {
  repoId: number;
  stars: number;
}

/**
 * The UTC midnight that a moment belongs to, as an ISO timestamp.
 *
 * A sample is an observation of a day, not of an instant. Storing instants would let sync frequency
 * masquerade as sampling quality — someone running `sync repos` hourly would accumulate 24 rows a
 * day per repository and a window query would weight their corpus differently from someone syncing
 * once, for no reason connected to the projects being measured.
 *
 * UTC rather than local time so that the bucket a sample lands in does not depend on where the
 * machine is, or on it moving.
 */
export function bucketToUtcDay(now: Date): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
}

/**
 * Records star counts for today, replacing any earlier reading from the same day.
 *
 * Last observation of the day wins, rather than first. Both are defensible; this one means the
 * newest figure the tool has seen is the one stored, which is what someone reading a row expects a
 * measurement to be. Duplicate suppression is the primary key's job, not the caller's.
 *
 * Repositories must already exist: the foreign key is deliberate, so a sample can never outlive the
 * row it describes and silently distort a window.
 */
export async function recordStars(samples: StarSample[], now = new Date()): Promise<number> {
  if (samples.length === 0) return 0;
  const observedAt = bucketToUtcDay(now);

  // Two sightings of the same repository in one run (a search query overlapping another) would make
  // a single statement contain two rows with the same key, which Postgres rejects outright:
  // "ON CONFLICT DO UPDATE command cannot affect row a second time". Deduplicate before sending.
  const latest = new Map<number, number>();
  for (const sample of samples) latest.set(sample.repoId, sample.stars);

  return bulkUpsert(db(), {
    table: 'repo_stars_history',
    columns: ['repo_id', 'observed_at', 'stars'],
    rows: [...latest].map(([repoId, stars]) => [repoId, observedAt, stars]),
    conflictTarget: ['repo_id', 'observed_at'],
    updateColumns: ['stars'],
  });
}

export interface StarHistoryCoverage {
  /** Rows in the table. */
  samples: number;
  /** Repositories with at least one sample. */
  repos: number;
  /** Days between the oldest sample and now, or null when there are none. */
  spanDays: number | null;
}

/**
 * How much history exists, for the status and corpus screens.
 *
 * Phase 0 is otherwise invisible, and invisible work is the work that gets rebuilt because nobody
 * could tell it had happened. A line saying "4 samples over 21 days" is how you know the clock is
 * actually running.
 */
export async function starHistoryCoverage(): Promise<StarHistoryCoverage> {
  const row = (
    await db().query<{ samples: string; repos: string; span_days: string | null }>(
      `select count(*)::text                                                as samples,
              count(distinct repo_id)::text                                 as repos,
              (extract(epoch from (now() - min(observed_at))) / 86400)::int::text as span_days
         from repo_stars_history`,
    )
  ).rows[0]!;

  return {
    samples: Number(row.samples),
    repos: Number(row.repos),
    // Null rather than 0: no samples is not a zero-day span, and the difference is the whole point
    // of the line.
    spanDays: row.span_days === null ? null : Number(row.span_days),
  };
}
