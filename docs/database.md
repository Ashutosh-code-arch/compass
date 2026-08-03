# Database

Postgres 14 or newer. Tested on 16.

Everything Compass knows lives here. The GitHub API is treated as a source to be cached, not queried
live — the corpus is the thing you rank against, and it survives your rate limit resetting.

---

## Migrations

Plain SQL files in `migrations/`, applied in filename order by a small runner. No ORM, no migration
framework.

```bash
npm run migrate
```

Safe to run repeatedly. Applied filenames are recorded in `schema_migrations`, so the runner skips what
it has already done and prints `Up to date (8 migration(s) applied).`

| File | What it added |
|---|---|
| `001_init.sql` | `repos`, `issues`, `sync_runs`, `decisions` |
| `002_maintainer_metrics.sql` | `repo_metrics` |
| `003_metric_calibration.sql` | Grace period and decidable-PR columns, after real data showed the first version over-counted ignored PRs |
| `004_setup_facts.sql` | `setup_facts` |
| `005_setup_run_kind.sql` | `setup` as a valid `sync_runs.kind` |
| `006_backfill_cursor.sql` | `repos.issues_backfill_page`, so an interrupted backfill resumes |
| `007_profile.sql` | `profile` |
| `008_stacks_and_full_tree.sql` | `setup_facts.frameworks` and the path-depth columns, after the root-only setup reading was found to under-report complex projects |

### Writing one

Create `migrations/008_your_change.sql`. Rules that matter here:

- **Forward-only.** There are no down migrations. Reversing means writing a new migration.
- **Comment the reasoning, not the syntax.** Look at `007_profile.sql` — it explains why the single-row
  constraint exists and what to do when multi-user arrives. That comment is worth more than the DDL.
- **Adding a value to a `CHECK` constraint needs a matching change in TypeScript.** `RUN_KINDS` in
  `src/sync/run.ts` mirrors `sync_runs.kind`, and there is a test that fails when they drift — after a
  drift once made every setup run fail on insert.
- SQL is validated structurally in the test suite, so a syntax error fails `npm test` rather than
  `npm run migrate`.

---

## Tables

### `repos`

One row per repository. The corpus.

| Column | Notes |
|---|---|
| `id`, `node_id`, `full_name`, `owner`, `name` | GitHub identity |
| `primary_language`, `topics`, `stars`, `forks` | What the profile and filters match on |
| `is_archived`, `is_disabled`, `is_fork`, `has_issues` | Gates |
| `discovered_via` | Which seed query found it, or `manual` for one added by name. **`prune` never pauses a `manual` row** |
| `meta_synced_at`, `meta_etag` | Conditional-GET state. A 304 costs no quota |
| `issues_synced_at` | Watermark handed back to the API as `since` |
| `issues_backfilled`, `issues_backfill_page` | First-pull progress, so an interrupted backfill resumes |
| `sync_state` | `active` \| `paused` \| `gone`. `prune` sets `paused` |
| `sync_error`, `sync_error_count` | Why a repository keeps failing |
| `raw` | The full API response, so a new field never needs a re-fetch |

Paused repositories are excluded from the shortlist and from `/api/languages`.

### `issues`

One row per issue.

| Column | Notes |
|---|---|
| `repo_id`, `number`, `title`, `body`, `html_url` | The issue |
| `state`, `state_reason`, `is_locked` | Gates |
| `labels`, `assignee_logins` | Text arrays. Assignment is a hard gate, not a penalty |
| `author_login`, `author_association` | `MEMBER` only reflects **public** org membership — see [design notes](design-notes.md) |
| `comment_count` | Contention proxy |
| `created_at_gh`, `updated_at_gh` | Age signals |
| `raw` | Full API response |

> Issue bodies can contain NUL bytes, which Postgres `text` rejects. Handled by a `JSON.stringify`
> replacer during mapping — not a post-serialisation regex, which was the first attempt and was wrong.

### `repo_metrics`

One row per repository. The output of `sync metrics`, and the most valuable data in the database.

| Column | Notes |
|---|---|
| `window_days`, `stale_days`, `grace_days` | The parameters this row was computed under |
| `prs_scanned`, `prs_in_window` | Sample size |
| `insider_prs`, `bot_prs`, `external_prs` | Only external PRs count as evidence about outsiders |
| `responded_prs`, `median_hours_response`, `p90_hours_response` | Nullable — no sample means no median |
| `no_response_rate` | The ignore rate |
| `merged_prs`, `closed_unmerged_prs`, `open_prs`, `merge_rate` | Whether work actually lands |
| `too_recent_prs`, `decidable_prs` | A PR opened yesterday is not evidence of anything yet |
| `confidence` | `none` \| `low` \| `medium` \| `high`. Low confidence halves the repo signals |
| `responsiveness` | `dormant` \| `slow` \| `moderate` \| `responsive` \| `unknown` |
| `detail` | Per-PR evidence, which is what `explain` prints |

Every derived statistic is nullable. **Null means unmeasured, never zero** — that distinction is carried
all the way to the interface, where it renders as a dash.

### `setup_facts`

One row per repository. The output of `sync setup`.

| Column | Notes |
|---|---|
| `files_seen`, `tree_truncated` | What the reading was based on |
| `compose_path`, `compose_services`, `compose_service_names`, `compose_builds_local` | Container topology |
| `has_dockerfile`, `has_devcontainer` | |
| `runtimes`, `package_manager`, `is_monorepo` | |
| `env_example_path`, `env_var_count` | How much configuration before it runs |
| `has_contributing`, `has_readme`, `task_runner` | Mitigations |
| `ci_workflow_count`, `ci_runs_on_pr` | Can you see your change validated before a human looks |
| `needs_database`, `needs_cache`, `needs_queue`, `external_services` | Backing services |
| `frameworks` | Detected frameworks, from dependencies plus matching topics. GIN-indexed. Empty means none detected, not none used |
| `compose_depth`, `env_depth` | Path depth, 0 for root. **Non-zero rows are ones the old root-only reading missed entirely** |
| `root_files_seen` | What the root-only reading would have counted, kept so the change is measurable |
| `setup_weight` | `light` \| `moderate` \| `heavy` \| `unknown` |
| `signals` | The raw facts behind the verdict |

> Read from the **whole tree** since migration 008. Compose and env files are found at any depth;
> root-level facts (Makefile, lockfiles) still come from the root deliberately. A truncated tree yields
> `unknown` rather than a confident verdict.

### `decisions`

One row per judgement. Append-only.

| Column | Notes |
|---|---|
| `issue_id` | |
| `verdict` | One of eight; `CHECK`-constrained |
| `predicted_hours`, `actual_hours` | Nullable. Recorded at different times, which is why this is append-only |
| `reason` | Free text |
| `created_at` | |

**Several rows per issue is normal and intended.** `started --hours 4` today and
`merged --actual-hours 9` next week are two rows; the journal groups them per issue to pair the
prediction with the outcome. A per-row view could never do that, which is why the journal query groups
in SQL.

Any decision removes the issue from future shortlists.

### `sync_runs`

One row per sync. The audit trail.

| Column | Notes |
|---|---|
| `kind` | `seed` \| `repos` \| `issues` \| `metrics` \| `setup`. Mirrors `RUN_KINDS` |
| `status` | `running` \| `ok` \| `failed` \| `aborted_budget` |
| `repos_seen`, `repos_upserted`, `issues_upserted` | Progress, flushed every 3 seconds while running |
| `http_requests`, `http_not_modified`, `http_retries`, `graphql_points` | What it cost |
| `rate_snapshot` | Per-resource limit and remaining at the end |
| `error`, `detail` | |

`aborted_budget` is **not a failure.** The run stopped before exhausting your GitHub allowance;
watermarks only advance for repositories that fully completed, so the next run resumes without a gap.

> A killed process leaves a row at `running` forever. `GET /api/sync` reports those without claiming to
> know whether they are a live CLI run or a corpse, because it genuinely cannot tell.

### `profile`

Exactly one row, enforced by `CHECK (id = 1)`. Your preferences.

| Column | Notes |
|---|---|
| `language_points`, `topic_points` | `jsonb` maps of name to points |
| `avoid_topics`, `avoid_labels` | Text arrays. These **extend** the built-in avoid list |
| `min_stars`, `max_stars` | Shortlist defaults, overridable per request |
| `max_setup_weight` | Same |

An all-defaults row is the "no profile" state and scores identically to the tool before profiles
existed. The row is inserted by the migration so reads never special-case its absence.

---

## Useful queries

```sql
-- What have I got?
select
  (select count(*) from repos)                              as repos,
  (select count(*) from repos where sync_state = 'paused')  as paused,
  (select count(*) from issues where state = 'open')         as open_issues,
  (select count(*) from repo_metrics)                        as measured,
  (select count(*) from setup_facts)                         as setup_read;

-- Where is maintainer attention actually good?
select r.full_name, m.responsiveness, m.median_hours_response, m.merge_rate, m.confidence
from repo_metrics m join repos r on r.id = m.repo_id
where m.confidence in ('medium', 'high')
order by m.median_hours_response nulls last
limit 20;

-- Which repositories are still unmeasured?
select r.full_name, r.stars
from repos r left join repo_metrics m on m.repo_id = r.id
where m.repo_id is null and r.sync_state = 'active'
order by r.stars desc;

-- How good are my time estimates?
select r.full_name || '#' || i.number as issue,
       max(d.predicted_hours) as predicted,
       max(d.actual_hours)    as actual
from decisions d join issues i on i.id = d.issue_id join repos r on r.id = i.repo_id
group by r.full_name, i.number
having max(d.predicted_hours) is not null and max(d.actual_hours) is not null;
```

---

## Backups

The corpus takes hours of API budget to rebuild, so it is worth keeping.

```bash
pg_dump compass | gzip > compass-$(date +%F).sql.gz
gunzip -c compass-2026-08-02.sql.gz | psql compass
```

A restored dump needs no GitHub token to read.

---

## Test fixtures

`fixtures/dev_corpus.sql` is a small corpus for working offline. Every row exists to hit a specific case
— the per-repo cap, the epic penalty, the assigned and locked gates, a dormant repository, a null that
must stay null.

```bash
createdb compass_dev
DATABASE_URL=postgres://localhost/compass_dev npm run migrate
psql compass_dev -f fixtures/dev_corpus.sql
DATABASE_URL=postgres://localhost/compass_dev npm run compass -- shortlist --min-score 0
```

Reload with `drop database` rather than truncating: `decisions` rows accumulate and change what the
shortlist gates out.
