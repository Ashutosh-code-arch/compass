-- Slice 1: corpus + sync.
--
-- Design notes:
--   * Primary keys are GitHub's numeric ids, which survive renames. full_name does not.
--   * Every row keeps the verbatim API payload in `raw`. You will change your mind about
--     which fields matter, and re-fetching is the expensive part. Reshaping from `raw` is free.
--   * `repos.issues_synced_at` is the incremental watermark handed back to the API as `since`.

create table if not exists schema_migrations (
  version    text primary key,
  applied_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- repos
-- ---------------------------------------------------------------------------

create table repos (
  id               bigint primary key,          -- GitHub repository id
  node_id          text not null unique,
  -- Intentionally NOT unique: when a repo is renamed and something else claims the old
  -- "owner/name", a UNIQUE here would make an otherwise valid upsert fail. id is the identity.
  full_name        text not null,
  owner            text not null,
  name             text not null,

  description      text,
  homepage         text,
  primary_language text,
  topics           text[] not null default '{}',
  license_spdx     text,

  stars            integer not null default 0,
  forks            integer not null default 0,
  watchers         integer not null default 0,
  -- GitHub's open_issues_count includes open PRs. Kept as reported; do not treat as issue count.
  open_issues_raw  integer not null default 0,
  size_kb          integer not null default 0,

  is_archived      boolean not null default false,
  is_disabled      boolean not null default false,
  is_fork          boolean not null default false,
  has_issues       boolean not null default true,
  default_branch   text,

  created_at_gh    timestamptz,
  updated_at_gh    timestamptz,
  pushed_at        timestamptz,

  -- discovery bookkeeping
  discovered_at    timestamptz not null default now(),
  discovered_via   text not null,               -- id of the seed query that surfaced it

  -- sync bookkeeping
  meta_synced_at   timestamptz,
  meta_etag        text,                        -- conditional GET on /repos/{o}/{n}; 304s are free
  issues_synced_at timestamptz,                 -- watermark for the next `since` query
  issues_backfilled boolean not null default false,  -- false until the initial open-issue pull completes

  sync_state       text not null default 'active'
    check (sync_state in ('active', 'paused', 'gone')),
  sync_error       text,
  sync_error_count integer not null default 0,

  raw              jsonb not null
);

create index repos_full_name_idx     on repos (full_name);
create index repos_active_idx        on repos (sync_state) where sync_state = 'active';
create index repos_stars_idx         on repos (stars desc);
create index repos_language_idx      on repos (primary_language);
create index repos_topics_idx        on repos using gin (topics);
create index repos_issues_synced_idx on repos (issues_synced_at nulls first);
create index repos_meta_synced_idx   on repos (meta_synced_at nulls first);

comment on column repos.discovered_via is
  'Seed query id from src/seeds/queries.ts. Lets you retire a query and see what it brought in.';
comment on column repos.issues_synced_at is
  'High-water mark. Next issue sync asks the API for everything updated since this instant (minus overlap).';

-- ---------------------------------------------------------------------------
-- issues
-- ---------------------------------------------------------------------------

create table issues (
  id                 bigint primary key,        -- GitHub issue id
  node_id            text not null unique,
  repo_id            bigint not null references repos (id) on delete cascade,
  number             integer not null,

  title              text not null,
  body               text,
  state              text not null check (state in ('open', 'closed')),
  state_reason       text,                      -- completed | not_planned | reopened | null
  labels             text[] not null default '{}',
  assignee_logins    text[] not null default '{}',
  author_login       text,
  author_association text,                      -- OWNER | MEMBER | COLLABORATOR | CONTRIBUTOR | NONE
  comment_count      integer not null default 0,
  is_locked          boolean not null default false,

  created_at_gh      timestamptz not null,
  updated_at_gh      timestamptz not null,
  closed_at_gh       timestamptz,

  html_url           text not null,

  first_seen_at      timestamptz not null default now(),
  last_synced_at     timestamptz not null default now(),

  raw                jsonb not null,

  unique (repo_id, number)
);

-- The workhorse index: open, unassigned, recently active issues in the corpus.
create index issues_open_idx    on issues (repo_id, updated_at_gh desc) where state = 'open';
create index issues_labels_idx  on issues using gin (labels);
create index issues_updated_idx on issues (updated_at_gh desc);
create index issues_created_idx on issues (created_at_gh desc);

comment on table issues is
  'Issues only. The REST list endpoint returns pull requests as issues; the sync filters them out.';

-- ---------------------------------------------------------------------------
-- sync_runs  (observability, and the budget evidence for the Slice 1 exit check)
-- ---------------------------------------------------------------------------

create table sync_runs (
  id                bigserial primary key,
  kind              text not null check (kind in ('seed', 'repos', 'issues')),
  started_at        timestamptz not null default now(),
  finished_at       timestamptz,
  status            text not null default 'running'
    check (status in ('running', 'ok', 'failed', 'aborted_budget')),

  repos_seen        integer not null default 0,
  repos_upserted    integer not null default 0,
  issues_upserted   integer not null default 0,

  http_requests     integer not null default 0,
  http_not_modified integer not null default 0,  -- 304s: served from ETag, cost no quota
  http_retries      integer not null default 0,

  rate_snapshot     jsonb not null default '{}', -- per-resource limit/remaining/reset at end of run
  error             text,
  detail            jsonb not null default '{}'
);

create index sync_runs_kind_started_idx on sync_runs (kind, started_at desc);

-- ---------------------------------------------------------------------------
-- decisions  (Slice 5 lives here; the table exists now so you can start logging immediately)
-- ---------------------------------------------------------------------------

create table decisions (
  id              bigserial primary key,
  issue_id        bigint not null references issues (id) on delete cascade,
  verdict         text not null check (verdict in (
                    'shortlisted', 'rejected', 'started', 'abandoned',
                    'submitted', 'merged', 'closed_unmerged', 'stalled')),
  predicted_hours numeric(5, 1),
  actual_hours    numeric(5, 1),
  reason          text,                          -- why this verdict, in your own words
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index decisions_issue_idx   on decisions (issue_id);
create index decisions_created_idx on decisions (created_at desc);

comment on table decisions is
  'Append-only journal of what you chose and what happened. Prediction vs. actual, by hand. '
  'This is the dataset any future learning loop needs; nothing infers from it yet.';
