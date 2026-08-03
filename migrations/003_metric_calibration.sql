-- Slice 2, calibration pass. Three corrections found by running the metrics against a real corpus.
--
-- 1. A merge is maintainer attention. Repos that squash-merge external PRs without leaving a
--    review comment were scoring 100% ignored alongside a 100% merge rate, which is incoherent.
--    `hours_since_last_review` is therefore renamed: reviews were never the only signal of life.
--
-- 2. A PR opened yesterday with no reply is not evidence of neglect. no_response_rate now excludes
--    PRs younger than grace_days unless they already got a response, which is the correct fixed-
--    horizon treatment. Previously the ignore rate was inflated by however busy the last week was.
--
-- 3. Bot accounts that are ordinary users with a MEMBER association (welcome bots, CI bots) were
--    counted as maintainer responses, producing 0-hour medians on dormant repos. See the
--    `responders` report and COMPASS_IGNORE_LOGINS for the empirical fix.

alter table repo_metrics rename column hours_since_last_review to hours_since_last_action;

alter table repo_metrics add column grace_days integer not null default 7;
alter table repo_metrics add column too_recent_prs integer not null default 0;
alter table repo_metrics add column decidable_prs integer not null default 0;

drop index if exists repo_metrics_median_idx;
create index repo_metrics_median_idx on repo_metrics (median_hours_response nulls last);

comment on column repo_metrics.hours_since_last_action is
  'Hours since the most recent maintainer action on an external PR — a submitted review OR a merge. '
  'Null means no maintainer has reviewed or merged an outside contribution in the window.';
comment on column repo_metrics.too_recent_prs is
  'External PRs younger than grace_days with no response yet. Excluded from no_response_rate: too '
  'early to call them ignored, and counting them punished repos simply for being busy this week.';
comment on column repo_metrics.decidable_prs is
  'Denominator of no_response_rate: responded PRs plus unresponded PRs older than grace_days.';

-- Existing rows were computed under the old definitions and must not be compared against new ones.
update repo_metrics set computed_at = 'epoch'::timestamptz;
