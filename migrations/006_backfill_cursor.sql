-- A truncated backfill correctly refuses to mark itself complete, since doing so would switch the
-- repo to incremental mode and permanently strand the open issues never reached. But it also
-- restarted from page 1 on every run, so repositories with more open issues than the page cap
-- (elastic/kibana, Expensify/App) burned the same requests forever without ever finishing.
--
-- Backfill pages are ordered by created_at ascending, which never changes for an existing issue, so
-- a page number is a stable cursor: new issues only ever appear on later pages.

alter table repos add column issues_backfill_page integer not null default 0;

comment on column repos.issues_backfill_page is
  'Pages of the initial open-issue backfill already stored. 0 means start from the beginning; '
  'reset to 0 once issues_backfilled flips true.';
