-- Phase 0: the clock starts.
--
-- Star velocity is the one signal in the roadmap that cannot be built on demand. It needs two
-- samples separated by weeks, so a table created on the day the feature is wanted is a table with
-- one row in it and a three-month wait attached. This migration therefore lands months before
-- anything reads it, which is the entire reason Phase 0 exists.
--
-- What velocity will be, once there is history: stars now, minus stars at the oldest sample inside
-- the window, per repo. Measured, dated, and derived from this corpus rather than from an external
-- index -- so it also covers the repositories no index lists.

create table repo_stars_history (
  repo_id     bigint not null references repos (id) on delete cascade,

  -- Bucketed to the UTC day by every writer (src/sync/stars.ts), so the primary key is what holds
  -- the resolution to one sample per repo per day. Syncing four times a day must not make a
  -- repository look four times better sampled than one synced daily, and the deduplication belongs
  -- in the key rather than in each caller's discipline.
  observed_at timestamptz not null default now(),

  stars       integer not null,

  primary key (repo_id, observed_at)
);

-- Velocity asks for "the oldest sample since date X" across many repos, which reads by date first.
create index repo_stars_history_observed_idx on repo_stars_history (observed_at);

comment on table repo_stars_history is
  'One star count per repository per UTC day. Written by every path that learns a star count: '
  'sync repos (including 304s, where the unchanged response is itself the observation), seed, and '
  'add. Read by nothing yet; Phase 3 computes velocity from it.';

comment on column repo_stars_history.observed_at is
  'Truncated to the UTC day by the writer. A sample is an observation of a day, not of an instant, '
  'and pretending otherwise would let sync frequency masquerade as sampling quality.';

-- A backdated first sample, from what is already stored.
--
-- repos.stars is an observation and repos.meta_synced_at is when it was made, so the corpus already
-- holds one dated sample per repository. Discarding it would start the clock later than it has to.
--
-- Dated at the sync that produced it and never at now(): claiming today for a figure fetched three
-- weeks ago would fabricate three flat weeks of history, and a velocity of zero invented that way
-- is worse than no velocity at all.
insert into repo_stars_history (repo_id, observed_at, stars)
select id,
       date_trunc('day', coalesce(meta_synced_at, discovered_at) at time zone 'UTC') at time zone 'UTC',
       stars
  from repos
on conflict (repo_id, observed_at) do nothing;
