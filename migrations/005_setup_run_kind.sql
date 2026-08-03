-- The sync_runs.kind CHECK constraint drifted behind the RunKind union in src/sync/run.ts: 'setup'
-- was added in code and not here, so every setup run failed at its very first insert.
--
-- src/sync/run.test.ts now asserts that RUN_KINDS and this constraint agree, so the two cannot
-- diverge silently again.

alter table sync_runs drop constraint sync_runs_kind_check;
alter table sync_runs add constraint sync_runs_kind_check
  check (kind in ('seed', 'repos', 'issues', 'metrics', 'setup'));
