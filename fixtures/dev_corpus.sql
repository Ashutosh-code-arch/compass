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
