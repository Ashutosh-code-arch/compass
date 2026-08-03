-- Two changes, both about answering "what is this project actually built with?"
--
-- 1. Detected frameworks, so "show me React projects" can be answered from declared dependencies
--    rather than from the repository name. Every manifest this is derived from was already being
--    fetched for runtime detection, so this costs no additional API budget.
--
-- 2. The setup reading now walks the whole file tree rather than the repository root. Projects that
--    keep their compose file in build/ or their env template in config/ previously read as `light`
--    when they were not — mattermost/mattermost being the example that made this worth fixing. The
--    new columns record where things were actually found, so a surprising verdict can be checked.

alter table setup_facts
  -- Canonical lowercase names from src/setup/stack.ts. A fixed vocabulary, not every dependency:
  -- a project with 400 transitive dependencies is not usefully described by all of them.
  add column frameworks       text[]  not null default '{}',

  -- Where the compose and env files were found, so a nested discovery is visible rather than implied.
  -- compose_path already exists; these record depth so the root-only regression cannot return silently.
  add column compose_depth    integer,
  add column env_depth        integer,

  -- Files in the whole tree, versus what the root-only reading would have seen. Keeping both means
  -- the improvement is measurable rather than asserted.
  add column root_files_seen  integer;

-- The filter matches against this, so it needs an index once the corpus is large.
create index setup_facts_frameworks_idx on setup_facts using gin (frameworks);

comment on column setup_facts.frameworks is
  'Detected frameworks and libraries, from declared dependencies plus GitHub topics that match the '
  'known vocabulary. Empty means none detected, which is not the same as none used.';

comment on column setup_facts.compose_depth is
  'Path depth of the compose file, 0 for root. Non-zero rows are ones the previous root-only reading '
  'would have missed entirely.';
