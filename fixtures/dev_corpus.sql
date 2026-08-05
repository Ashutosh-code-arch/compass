-- A tiny corpus for exercising the ranking and API layers without GitHub.
--
-- Not sample data for its own sake: each row exists to hit a case that has broken before or that the
-- pure tests cannot reach on their own.
--
--   hog/monopoly       10 labelled issues in one repo -> the per-repo cap, and heldBackInRepo
--   acme/widgets#13    a 6,000-char body titled "Master FR: ..." -> the epic/scope penalty
--   hog/monopoly#31    assigned -> must be gated out in SQL, not penalised in the score
--   hog/monopoly#32    locked -> same
--   ghost/townn        responsiveness 'dormant' -> gated out unless --include-dormant
--   acme/gizmos        'slow', setup 'moderate', Python -> gives --language and --max-setup
--                      something to actually filter, and a non-null compose_services
--   acme/widgets       setup_facts with compose_services NULL -> proves null survives as null
--   acme/gizmos        contributor_agreement 'cla'; hog/monopoly 'dco'; acme/widgets null
--                      -> the three cases the UI renders differently, unmeasured included
--   hog/monopoly       four negative decisions, three sharing a reason -> the rejection pattern,
--                      which cannot be reached without journal rows
--   repo_stars_history two samples per repo, 24 days apart -> a non-zero span. The migration
--                      backfill cannot produce these, because it runs before this file is loaded
--   star history       a surge on hog/monopoly against a 200-day-old repo -> `hype`, since its queue is
--                      214 deep. acme grows modestly -> `steady`. ghost loses stars -> `cooling`
--   issue_claims       one of each verdict, with ages -> the current-state line, --exclude-claimed,
--                      and the rule that a verdict is never shown without how old it is
--   open_pr_total      214 with an 840-day-old oldest on hog/monopoly -> a queue that does not move,
--                      which the count alone cannot express
--
-- Usage:
--   createdb compass_dev
--   DATABASE_URL=postgres://localhost/compass_dev npm run compass -- migrate
--   psql compass_dev -f fixtures/dev_corpus.sql
--   DATABASE_URL=postgres://localhost/compass_dev npm run compass -- shortlist --min-score 0
--
-- This is what the Slice 6 refactor was diffed against: run the old and new implementations over the
-- same loaded corpus and compare stdout. Reload with `drop database` rather than truncating, since
-- decisions rows accumulate and change what the shortlist gates out.
--
-- The decisions below are on hog/monopoly candidates the per-repo cap already holds back, so the rows
-- the shortlist DISPLAYS are unchanged by their presence. The counts around them — considered,
-- scoring, total, heldBackInRepo — do move, which is correct: four issues really have been judged.

insert into repos (id, node_id, full_name, owner, name, primary_language, stars, discovered_via, raw, default_branch)
values
  (1, 'R_1', 'acme/widgets',  'acme', 'widgets',  'TypeScript', 4200,  'seed', '{}', 'main'),
  (2, 'R_2', 'acme/gizmos',   'acme', 'gizmos',   'Python',     11000, 'seed', '{}', 'main'),
  (3, 'R_3', 'hog/monopoly',  'hog',  'monopoly', 'TypeScript', 2600,  'seed', '{}', 'main'),
  (4, 'R_4', 'ghost/townn',   'ghost','townn',    'Go',          900,  'seed', '{}', 'main');

insert into repo_metrics (repo_id, window_days, stale_days, prs_scanned, prs_in_window, external_prs,
    responded_prs, median_hours_response, no_response_rate, merged_prs, closed_unmerged_prs,
    open_prs, merge_rate, confidence, responsiveness, decidable_prs)
values
  (1, 180, 30, 40, 38, 22, 20,  5.50, 0.090, 18, 3, 4, 0.850, 'high',   'responsive', 21),
  (2, 180, 30, 40, 35, 18, 12, 62.00, 0.330, 10, 6, 5, 0.620, 'medium', 'slow',       17),
  (3, 180, 30, 40, 30, 15, 14,  9.00, 0.070, 12, 2, 3, 0.800, 'high',   'responsive', 14),
  (4, 180, 30, 40, 12,  9,  1, 30.00, 0.890,  1, 7, 6, 0.125, 'low',    'dormant',     9);

insert into setup_facts (repo_id, files_seen, setup_weight, env_var_count, has_contributing,
    has_readme, task_runner, ci_runs_on_pr, compose_services, has_devcontainer)
values
  (1, 40, 'light',    3,  true,  true, 'npm',  true, null, false),
  (2, 55, 'moderate', 14, true,  true, 'make', true, 7,    false),
  (3, 30, 'light',    2,  false, true, 'npm',  true, null, true),
  (4, 20, 'heavy',    31, false, true, null,   null, 12,   false);
insert into issues (id, node_id, repo_id, number, title, body, state, labels, assignee_logins, author_association, comment_count, is_locked, created_at_gh, updated_at_gh, html_url, raw) values
(1001, 'I_1001', 1, 11, 'Fix off-by-one in the pagination helper', repeat('x', 400), 'open', ARRAY['good first issue','bug']::text[], '{}', 'NONE', 2, false, now() - interval '90 days', now() - interval '1 day', 'https://github.invalid/1/issues/11', '{}'),
(1002, 'I_1002', 1, 12, 'Document the retry policy', repeat('x', 400), 'open', ARRAY['documentation','help wanted']::text[], '{}', 'NONE', 1, false, now() - interval '60 days', now() - interval '1 day', 'https://github.invalid/1/issues/12', '{}'),
(1003, 'I_1003', 1, 13, 'Master FR: Pen, Stylus and Handwriting support', repeat('x', 6000), 'open', ARRAY['good first issue']::text[], '{}', 'NONE', 4, false, now() - interval '30 days', now() - interval '1 day', 'https://github.invalid/1/issues/13', '{}'),
(1004, 'I_1004', 2, 21, 'Add a --dry-run flag to the importer', repeat('x', 400), 'open', ARRAY['help wanted']::text[], '{}', 'NONE', 3, false, now() - interval '120 days', now() - interval '1 day', 'https://github.invalid/2/issues/21', '{}'),
(1005, 'I_1005', 2, 22, 'Flaky test in test_scheduler.py', repeat('x', 400), 'open', ARRAY['bug','tests']::text[], '{}', 'NONE', 5, false, now() - interval '45 days', now() - interval '1 day', 'https://github.invalid/2/issues/22', '{}'),
(1006, 'I_1006', 3, 31, 'Assigned already, should never be shortlisted', repeat('x', 400), 'open', ARRAY['good first issue']::text[], '{someone}', 'NONE', 0, false, now() - interval '20 days', now() - interval '1 day', 'https://github.invalid/3/issues/31', '{}'),
(1007, 'I_1007', 3, 32, 'Locked thread, should never be shortlisted', repeat('x', 400), 'open', ARRAY['good first issue']::text[], '{}', 'NONE', 0, true, now() - interval '20 days', now() - interval '1 day', 'https://github.invalid/3/issues/32', '{}'),
(1008, 'I_1008', 4, 41, 'Nobody is home in this repo', repeat('x', 400), 'open', ARRAY['good first issue']::text[], '{}', 'NONE', 0, false, now() - interval '200 days', now() - interval '1 day', 'https://github.invalid/4/issues/41', '{}'),
(1009, 'I_1009', 3, 100, 'Monopoly candidate 0', repeat('x', 400), 'open', ARRAY['good first issue','documentation']::text[], '{}', 'NONE', 1, false, now() - interval '80 days', now() - interval '1 day', 'https://github.invalid/3/issues/100', '{}'),
(1010, 'I_1010', 3, 101, 'Monopoly candidate 1', repeat('x', 400), 'open', ARRAY['good first issue','documentation']::text[], '{}', 'NONE', 1, false, now() - interval '81 days', now() - interval '1 day', 'https://github.invalid/3/issues/101', '{}'),
(1011, 'I_1011', 3, 102, 'Monopoly candidate 2', repeat('x', 400), 'open', ARRAY['good first issue','documentation']::text[], '{}', 'NONE', 1, false, now() - interval '82 days', now() - interval '1 day', 'https://github.invalid/3/issues/102', '{}'),
(1012, 'I_1012', 3, 103, 'Monopoly candidate 3', repeat('x', 400), 'open', ARRAY['good first issue','documentation']::text[], '{}', 'NONE', 1, false, now() - interval '83 days', now() - interval '1 day', 'https://github.invalid/3/issues/103', '{}'),
(1013, 'I_1013', 3, 104, 'Monopoly candidate 4', repeat('x', 400), 'open', ARRAY['good first issue','documentation']::text[], '{}', 'NONE', 1, false, now() - interval '84 days', now() - interval '1 day', 'https://github.invalid/3/issues/104', '{}'),
(1014, 'I_1014', 3, 105, 'Monopoly candidate 5', repeat('x', 400), 'open', ARRAY['good first issue','documentation']::text[], '{}', 'NONE', 1, false, now() - interval '85 days', now() - interval '1 day', 'https://github.invalid/3/issues/105', '{}'),
(1015, 'I_1015', 3, 106, 'Monopoly candidate 6', repeat('x', 400), 'open', ARRAY['good first issue','documentation']::text[], '{}', 'NONE', 1, false, now() - interval '86 days', now() - interval '1 day', 'https://github.invalid/3/issues/106', '{}'),
(1016, 'I_1016', 3, 107, 'Monopoly candidate 7', repeat('x', 400), 'open', ARRAY['good first issue','documentation']::text[], '{}', 'NONE', 1, false, now() - interval '87 days', now() - interval '1 day', 'https://github.invalid/3/issues/107', '{}'),
(1017, 'I_1017', 3, 108, 'Monopoly candidate 8', repeat('x', 400), 'open', ARRAY['good first issue','documentation']::text[], '{}', 'NONE', 1, false, now() - interval '88 days', now() - interval '1 day', 'https://github.invalid/3/issues/108', '{}'),
(1018, 'I_1018', 3, 109, 'Monopoly candidate 9', repeat('x', 400), 'open', ARRAY['good first issue','documentation']::text[], '{}', 'NONE', 1, false, now() - interval '89 days', now() - interval '1 day', 'https://github.invalid/3/issues/109', '{}');

-- ---------------------------------------------------------------------------
-- Phase 0 rows.
--
-- These cannot come from the migration backfills: migrations run before this file is loaded, so an
-- `organizations` row and a first star sample would both be created against an empty repos table.
-- ---------------------------------------------------------------------------

insert into organizations (login, first_seen_at)
select owner, min(discovered_at) from repos group by owner
on conflict (login) do nothing;

-- Two samples per repo, 24 days apart, so the span is real rather than same-day. The older reading is
-- lower, which is what a growing project looks like and what velocity will eventually read.
insert into repo_stars_history (repo_id, observed_at, stars)
select id, date_trunc('day', now() at time zone 'UTC') at time zone 'UTC', stars from repos
on conflict (repo_id, observed_at) do nothing;

insert into repo_stars_history (repo_id, observed_at, stars)
select id,
       date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' - interval '24 days',
       greatest(stars - 300, 0)
  from repos
on conflict (repo_id, observed_at) do nothing;

-- A CLA, a DCO, and one left unmeasured. acme/widgets keeps contributor_agreement null on purpose:
-- 'none' would claim the file was read and said nothing, and nothing here read a file at all.
update setup_facts
   set contributor_agreement = 'cla',
       agreement_evidence = ARRAY['contributor license agreement']::text[],
       contributing_path = 'CONTRIBUTING.md'
 where repo_id = 2;

update setup_facts
   set contributor_agreement = 'dco',
       agreement_evidence = ARRAY['Signed-off-by', 'commit -s']::text[],
       contributing_path = '.github/CONTRIBUTING.md'
 where repo_id = 3;

-- Four negative outcomes in one repo, three of them phrased the same way after normalisation. Enough
-- to clear MIN_PATTERN_DECISIONS and MIN_REASON_REPEATS, so the shortlist and `why` both show the
-- pattern. Issues 107-109 and 106 are all past the per-repo cap already.
insert into decisions (issue_id, verdict, reason, created_at) values
  (1016, 'rejected',  'needs design discussion first',   now() - interval '9 days'),
  (1017, 'rejected',  'Needs design discussion first.',  now() - interval '6 days'),
  (1018, 'rejected',  'needs  design discussion  first', now() - interval '4 days'),
  (1015, 'abandoned', 'maintainer went quiet mid-review', now() - interval '2 days');

-- ---------------------------------------------------------------------------
-- Phase 2 rows: current state, which decays.
--
-- Deliberately spread across verdicts and ages. `contested` two days old is the case the feature
-- exists for; `in-progress` twenty days old exercises the rule that reported work does not go stale on
-- the intent clock; and issue 1011 stays `free` so that --exclude-claimed can be seen keeping something
-- rather than only dropping things.
-- ---------------------------------------------------------------------------

-- A queue that does not move, and one that does.
update repo_metrics
   set open_pr_total = 214,
       oldest_open_pr_at = now() - interval '840 days',
       oldest_open_pr_number = 77
 where repo_id = 3;

update repo_metrics
   set open_pr_total = 4,
       oldest_open_pr_at = now() - interval '9 days',
       oldest_open_pr_number = 12
 where repo_id = 1;

insert into issue_claims (issue_id, checked_at, verdict, claimants, latest_claim_at, latest_claimant,
                          progress_at, progress_by, linked_prs, bounty_hint,
                          comments_read, comments_total) values
  -- Seven volunteers, nobody assigned. The evening-waster.
  (1010, now() - interval '2 days',  'contested',   7, now() - interval '3 days',  'ada',
   null, null, '{}', null, 41, 41),
  -- Checked and genuinely free.
  (1011, now() - interval '1 day',   'free',        0, null, null,
   null, null, '{}', null, 2, 2),
  -- Work in flight. Twenty days old and still authoritative: a branch does not evaporate.
  (1012, now() - interval '20 days', 'in-progress', 1, now() - interval '25 days', 'grace',
   now() - interval '24 days', 'grace', '{https://github.com/hog/monopoly/pull/9}', null, 12, 12),
  -- Asked for long ago, then silence. Probably available again.
  (1013, now() - interval '5 days',  'stale-claim', 1, now() - interval '70 days', 'linus',
   null, null, '{}', '/bounty command', 8, 8),
  -- A verdict formed from part of a long thread. The reader has to be able to see the shortfall.
  (1014, now() - interval '30 days', 'claimed',     1, now() - interval '31 days', 'margaret',
   null, null, '{}', null, 100, 412);

-- Bounty labels, which need no fetch at all.
update issues set labels = array['good first issue', 'bounty', '$150'] where id = 1013;

-- ---------------------------------------------------------------------------
-- Phase 3 rows: momentum.
--
-- Enough star history, far enough apart, to clear MIN_SPAN_DAYS and produce one of each verdict. Without
-- these the momentum column is a row of dashes, which is correct but exercises nothing.
-- ---------------------------------------------------------------------------

-- Young and surging. Combined with its 214-deep queue this is the hype case.
update repos set created_at_gh = now() - interval '200 days' where id = 3;
-- Mature and growing normally.
update repos set created_at_gh = now() - interval '2500 days' where id = 1;

insert into repo_stars_history (repo_id, observed_at, stars) values
  (3, date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' - interval '75 days', 900),
  (1, date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' - interval '75 days', 3900),
  -- Losing stars: gained <= 0 is `cooling`, and is reported as a loss rather than clamped to zero.
  (4, date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' - interval '75 days', 1200)
on conflict (repo_id, observed_at) do update set stars = excluded.stars;
