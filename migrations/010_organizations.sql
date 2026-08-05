-- Phase 0: an organisation becomes a thing rather than a string.
--
-- Today a repository carries an `owner` text column and nothing else in the schema knows that
-- organisations exist. But the first question this tool is actually asked is "which organisations
-- are worth my time?" -- GSoC publishes organisations, ROSS ranks organisations, and a student picks
-- an organisation before an issue. That needs an object to hang facts on.
--
-- Nothing is fetched here and no measured value is copied. `organizations` is identity plus curated
-- flags; responsiveness, merge rate and setup cost stay where they are measured and are rolled up by
-- query in Phase 1. A stored rollup would be a number that can silently disagree with the metrics it
-- claims to summarise.

create table organizations (
  -- The GitHub login, which is exactly what repos.owner holds. Joining on it avoids backfilling a
  -- foreign key onto a thousand existing rows for an object that has no independent lifecycle yet.
  --
  -- Renames: repos.owner follows the rename on the next metadata sync and the old row is left behind
  -- with no repositories pointing at it. Visible and harmless, which is better than a numeric id
  -- that quietly keeps a stale name attached to live repositories.
  login         text primary key,

  -- Null means not fetched. No payload the corpus already stores carries an organisation's display
  -- name, and Phase 0 spends no API budget.
  display_name  text,

  first_seen_at timestamptz not null default now()
);

-- Curated claims about an organisation: one row per claim, each carrying the date a human last
-- checked it.
--
-- The roadmap sketched these as array columns on a single row (gsoc_years integer[], funding text,
-- ross_quarter text, market text[]) with a reviewed_at. They are a tall table instead, for one
-- reason: a single reviewed_at cannot say when *each* value was checked, and "GSoC 2024, 2025, 2026"
-- last reviewed in February means something quite different from the same list reviewed today. The
-- roadmap's own requirement is a review date on every curated value, so the shape follows the
-- requirement rather than the sketch.
create table org_tags (
  org_login   text not null references organizations (login) on delete cascade,

  kind        text not null
    check (kind in ('gsoc_year', 'funding', 'ross_quarter', 'market', 'note')),

  -- Text for every kind, years included. A `gsoc_year` of '2026' and a `funding` of 'yc-w22' are
  -- both claims about an organisation; typing one of them as integer would need a second table to
  -- express the same idea twice.
  value       text not null,

  -- Where the claim came from: a URL, a dataset release, a person. Null means unrecorded, which is
  -- itself worth being able to see.
  source      text,

  -- Not null on purpose. There is no way to add a curated value without stating when it was checked,
  -- because an undated curated value is a lie waiting to happen.
  reviewed_at date not null,

  primary key (org_login, kind, value)
);

-- "Which organisations are in GSoC 2026" and "which are YC-funded" both read kind first.
create index org_tags_kind_value_idx on org_tags (kind, value);

comment on table organizations is
  'Identity only. Every measured fact about an organisation is a rollup over its repositories, '
  'computed by query so it cannot go stale behind the metrics it summarises.';

comment on table org_tags is
  'Curated, not measured. Each row is one human claim with its own review date, so an eighteen-'
  'month-old GSoC list cannot be presented with the same authority as this week''s.';

-- Backfill from the corpus, dated honestly: an organisation was first seen when the first of its
-- repositories was discovered, not when this migration ran.
insert into organizations (login, first_seen_at)
select owner, min(discovered_at)
  from repos
 group by owner
on conflict (login) do nothing;
