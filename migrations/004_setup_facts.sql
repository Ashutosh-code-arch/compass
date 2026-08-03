-- Slice 3: setup complexity.
--
-- Deliberately facts, not estimates. "7 services, needs Postgres and Kafka, 14 env vars, Node 22"
-- is actionable and checkable against the repo by eye. "35 minutes" is a guess you stop believing
-- the third time setup takes three hours, and once you stop believing one number you stop believing
-- the report. The only judgement here is an ordinal setup_weight, on the same basis as
-- repo_metrics.responsiveness.
--
-- Everything is derived from files at the default branch HEAD. No LLM, no heuristic guessing about
-- intent: a compose file either declares seven services or it does not.

create table setup_facts (
  repo_id        bigint primary key references repos (id) on delete cascade,
  computed_at    timestamptz not null default now(),

  -- If GitHub truncated the tree listing, absence of a file proves nothing.
  tree_truncated boolean not null default false,
  files_seen     integer not null default 0,

  -- containerisation
  compose_path          text,
  compose_services      integer,
  compose_service_names text[] not null default '{}',
  compose_builds_local  boolean,          -- builds from source vs pulls prebuilt images
  has_dockerfile        boolean not null default false,
  has_devcontainer      boolean not null default false,

  -- runtimes: [{ name, constraint, source }]
  runtimes        jsonb not null default '[]',
  package_manager text,
  is_monorepo     boolean not null default false,

  -- configuration burden
  env_example_path text,
  env_var_count    integer,

  -- documented entry points
  has_contributing boolean not null default false,
  has_readme       boolean not null default false,
  task_runner      text,                  -- make | task | just | none

  -- CI. null means undetermined rather than absent: only well-known workflow filenames are read.
  ci_workflow_count integer not null default 0,
  ci_runs_on_pr     boolean,

  -- backing services implied by compose images
  external_services text[] not null default '{}',
  needs_database    boolean not null default false,
  needs_cache       boolean not null default false,
  needs_queue       boolean not null default false,

  setup_weight text not null
    check (setup_weight in ('unknown', 'light', 'moderate', 'heavy')),

  -- Every input that fed the weight, so any verdict can be argued with.
  signals jsonb not null default '{}'
);

create index setup_facts_weight_idx    on setup_facts (setup_weight);
create index setup_facts_services_idx  on setup_facts (compose_services nulls first);
create index setup_facts_computed_idx  on setup_facts (computed_at nulls first);

comment on column setup_facts.tree_truncated is
  'GitHub truncates very large tree listings. When true, a false in any has_* column means '
  '"not seen", not "not present".';
comment on column setup_facts.ci_runs_on_pr is
  'Null means undetermined. Only a handful of conventional workflow filenames are fetched, so a '
  'project with CI in an unusually named file reads as unknown rather than as having none.';
comment on column setup_facts.setup_weight is
  'Ordinal, from thresholds in src/setup/parse.ts. A devcontainer or task runner is reported '
  'separately rather than folded in: "heavy but has a devcontainer" is a different situation from '
  '"heavy with no documented path in".';
