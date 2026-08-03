# Roadmap

What is built, what is not, and what is worth doing next.

---

## Built

| | Status |
|---|---|
| Corpus discovery and issue sync | Working |
| Maintainer attention metrics | Working, corrected through six rounds against a 1,000-repo corpus |
| Setup complexity | Working, **root-level files only** |
| Ranking with itemised breakdowns | Working |
| Decisions journal and calibration | Working |
| `prune` | Working |
| JSON API | Working |
| Web interface — shortlist, why, decide, journal | Working |
| Skills profile and reputation gate | Working |
| Pagination, language picker, sync from the UI | Working |
| Add a project by name (`add`) | Working |
| Filter by what a project is built with (`--stack`) | Working |
| First-run guidance on the corpus screen | Working |
| Full-tree setup reading | Working |

---

## The honest state of it

The parts backed by real data are the **measurements**: whether maintainers review outside work, and what
it costs to get a project running. Those went through six rounds of correction against a real corpus, and
the tests encode what was learned.

**The scoring weights have had zero validation against outcomes.** They are a preference function written
from reasoning, not a model fitted to anything. The score's job is to order candidates; `why` exists so you
can disagree with any line.

Nearly 200 tests is not 200 tests' worth of validated weights. Most of them assert that the machinery does
what it says, not that what it says is right.

---

## The highest-value thing to do next is not code

Work three issues from the shortlist and record `--hours` when you start and `--actual-hours` when you
finish.

Three pairs gets you an average estimate error. **Fifteen turns `weights.ts` from assertion into
measurement** — and it is also the only thing that will answer whether a language model reading issue
bodies would add anything, which is the largest open architectural question here.

Everything below is speculative until those rows exist.

---

## Known limitations worth fixing

### ~~Setup reads root-level files only~~ — fixed

Migration 008. The reading walks the full tree via `git/trees?recursive=1`, one extra request per
repository. Compose and env files are found at any depth and `compose_depth` records where.

Truncation is handled rather than ignored: a partial listing yields `unknown`, which also fixed a latent
bug where `classifySetupWeight` accepted `treeTruncated` and never read it.

**This unblocks the setup-instructions generator**, which is now the most valuable feature left.

### `report.ts` has not been split

`maintainers`, `responders`, `explain` and `setup` still mix querying with terminal formatting. The same
`view` / `data` / `render` split applied to `rank/` needs repeating four times. Until then those reports
have no API endpoints and no screens.

Do it when a screen needs them. The dashboard would.

### The job runner is not a queue

`http/jobs.ts` runs syncs in-process with an in-process lock. A killed server leaves a `sync_runs` row at
`running` forever, and the UI reports those without claiming to know whether they are a live CLI run or a
corpse — because it cannot tell.

Fine for one user. If it needs to be reliable, that is the thing to replace.

### Nothing is indexed for ranking

`shortlist` takes 2–4 seconds on a corpus of ~86,000 issues. The 50,000-row fetch cap is reachable at that
size, and when hit, the ranking has seen a recency-ordered subset. The `fetch-cap-hit` notice reports it.

The obvious next optimisation, if it starts to grate.

---

## Features not built

### A setup-instructions generator

`setup_facts` already holds the raw material — runtimes and versions, compose service count and names,
backing services, env var count and template path, task runner, devcontainer, CI-on-PR. Turning that into
an ordered checklist is deterministic template work:

> Install Node ≥22 and Docker; `cp .env.example .env` and fill 14 variables; `docker compose up` starts 7
> services including Postgres and Kafka; `make test`.

**Do not let it emit invented minute estimates.** That is the false-precision failure the whole project has
been avoiding. The recursive-tree prerequisite is now done, so this is unblocked.

### A workflow board

The journal screen already renders the verdict trail per issue, and the decision dialog captures
predictions on opening verdicts and outcomes on closing ones — the part that actually populates
calibration.

What does not exist is a Kanban-style *board*: columns by latest verdict, drag to advance. Worth doing only
if you find yourself tracking several issues at once; with one or two in flight, the list is better.

### A dashboard

Deliberately last. The shortlist and the decision capture are what make the tool worth opening, and the
dashboard is the only screen that needs the `report.ts` refactor first.

### Multi-user

Nothing here is designed for it. `profile` is a single row enforced by a `CHECK` constraint, there is no
auth, and the server binds localhost. When it arrives: drop the constraint, add an owner column, add GitHub
OAuth. Adding any of that now would be scaffolding for a requirement that does not exist.

---

## Open questions

**Would a language model reading issue bodies help?** It could judge whether an issue is actually
self-contained, which no counting signal captures. It would also add cost, latency and non-determinism to
arithmetic that currently has none. **The decisions journal is how to answer this**: if the weights turn out
to predict effort badly, and the failures cluster in issues whose bodies read misleadingly, that is the
evidence for it. Not before.

**Should responsiveness decay with age?** A metric from three months ago is treated the same as one from
yesterday. Maintainer behaviour changes — a project can lose its only active reviewer. Some staleness
penalty is probably right, but the shape is unknown.

**Is the star band right?** 1,000–30,000 comes from reasoning about abandonment risk versus queue crowding,
not from measurement. The journal could test it.

---

## If you want to contribute

Read [Development](development.md) first, particularly the conventions. Two things matter more than
anything else here:

**`null` means unmeasured, never zero.** Reporting absence as zero is the easiest way to make this tool
lie, and it is guarded from the SQL to the interface.

**Comments explain why, not what.** `weights.ts` is the model — every number carries the observation that
produced it. A change to a weight without a reason attached will be a mystery in three months.
