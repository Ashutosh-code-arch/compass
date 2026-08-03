-- Slice 2: maintainer responsiveness.
--
-- The premise: most external contributions fail because nobody reviewed them, not because the
-- contributor lacked skill. These columns are meant to eliminate repos before you invest hours.
--
-- A statistical warning is baked into the column set on purpose. `median_hours_to_response` is
-- computed only over PRs that actually got a response, which right-censors the sample: a dead
-- repo where 2 of 40 external PRs got a fast reply and 38 were ignored has an excellent median.
-- That is why no_response_rate and open_stale_rate exist, and why nothing should ever read the
-- median without also reading them.

alter table sync_runs drop constraint sync_runs_kind_check;
alter table sync_runs add constraint sync_runs_kind_check
  check (kind in ('seed', 'repos', 'issues', 'metrics'));

alter table sync_runs add column graphql_points integer not null default 0;

create table repo_metrics (
  repo_id      bigint primary key references repos (id) on delete cascade,
  computed_at  timestamptz not null default now(),

  -- inputs, recorded so a metric can always be re-derived or dismissed
  window_days  integer not null,
  stale_days   integer not null,

  -- sample composition
  prs_scanned          integer not null default 0,  -- PRs returned by the API
  prs_in_window        integer not null default 0,
  insider_prs          integer not null default 0,  -- OWNER / MEMBER / COLLABORATOR
  bot_prs              integer not null default 0,  -- dependabot et al; would wreck every ratio
  external_prs         integer not null default 0,  -- the actual denominator

  -- responsiveness, over external PRs only
  responded_prs         integer not null default 0,
  median_hours_response numeric(10, 2),
  p90_hours_response    numeric(10, 2),
  no_response_rate      numeric(4, 3),

  -- outcomes
  merged_prs            integer not null default 0,
  closed_unmerged_prs   integer not null default 0,
  open_prs              integer not null default 0,
  merge_rate            numeric(4, 3),               -- of decided PRs, not of all PRs
  median_hours_to_merge numeric(10, 2),

  -- friction and liveness
  changes_requested_rate numeric(4, 3),
  open_stale_prs         integer not null default 0,
  open_stale_rate        numeric(4, 3),
  hours_since_last_review numeric(12, 2),            -- null means: no external PR ever reviewed

  -- ordinal verdicts. Deliberately not a 0-100 score: nothing here supports that precision.
  confidence     text not null check (confidence in ('none', 'low', 'medium', 'high')),
  responsiveness text not null check (responsiveness in
    ('unknown', 'dormant', 'slow', 'moderate', 'responsive')),

  -- per-PR observations, so any number above can be audited back to the PRs that produced it
  detail jsonb not null default '{}'
);

create index repo_metrics_responsiveness_idx on repo_metrics (responsiveness, confidence);
create index repo_metrics_computed_idx       on repo_metrics (computed_at nulls first);
create index repo_metrics_median_idx         on repo_metrics (median_hours_response nulls last);

comment on column repo_metrics.median_hours_response is
  'Median hours to first maintainer response, over responded external PRs ONLY. '
  'Right-censored: read alongside no_response_rate or it will flatter dormant repos.';
comment on column repo_metrics.merge_rate is
  'merged / (merged + closed_unmerged). Open PRs are excluded because their outcome is unknown, '
  'not because it is favourable.';
comment on column repo_metrics.confidence is
  'Sample-size bucket from external_prs. "low" means the numbers are anecdote; do not rank on them.';
comment on column repo_metrics.responsiveness is
  'Ordinal bucket from hand-set thresholds in src/metrics/compute.ts. These are opening guesses, '
  'to be recalibrated against the decisions journal once it has rows.';
