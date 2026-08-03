# CLI reference

Every command takes the form:

```bash
npm run compass -- <command> [flags]
```

The `--` matters. It tells npm to pass what follows to Compass rather than interpreting it itself. If
you forget it, npm will silently swallow your flags.

There are shortcuts for the three most common:

```bash
npm run migrate   # same as: npm run compass -- migrate
npm run status    # same as: npm run compass -- status
npm run serve     # same as: npm run compass -- serve
```

`npm run compass -- --help` prints a summary at any time.

---

## Contents

- [Setup](#setup)
- [Fetching data](#fetching-data)
- [Finding work](#finding-work)
- [Recording decisions](#recording-decisions)
- [Corpus reports](#corpus-reports)
- [Housekeeping](#housekeeping)
- [The server](#the-server)
- [Flags that appear everywhere](#flags-that-appear-everywhere)

---

## Setup

### `migrate`

Applies any database migrations that have not run yet.

```bash
npm run compass -- migrate
```

Safe to run repeatedly — it tracks what has already been applied and skips it. Run this after every
`git pull`.

Needs `DATABASE_URL`. Does **not** need a GitHub token.

---

## Fetching data

All four of these talk to GitHub and spend your hourly request allowance. They stop before exhausting
it and resume where they stopped, so running them repeatedly is safe.

They must run in this order the first time, because each depends on the one before:

```
seed  →  sync issues  →  sync metrics  →  sync setup
```

### `seed`

Discovers repositories by running the searches defined in `src/seeds/queries.ts`, which target a
1,000–30,000 star band.

```bash
npm run compass -- seed                      # everything
npm run compass -- seed --dry-run            # show what it would search, write nothing
npm run compass -- seed --only python,rust   # only named queries
npm run compass -- seed --max-pages 2        # cap pages per query, to keep it cheap
```

| Flag | Meaning |
|---|---|
| `--dry-run` | Print the resolved queries and result counts without writing |
| `--only id,id` | Restrict to specific seed query ids |
| `--max-pages N` | Override each query's page cap |

### `sync repos`

Refreshes stars, primary language, topics and default branch for repositories you already have.

```bash
npm run compass -- sync repos                       # everything stale
npm run compass -- sync repos --limit 500
npm run compass -- sync repos --repo facebook/react # one project
npm run compass -- sync repos --stale-hours 0       # force-refresh everything
```

| Flag | Default | Meaning |
|---|---|---|
| `--stale-hours N` | 24 | Skip repos refreshed more recently than this |
| `--limit N` | all | How many repositories to process |
| `--repo owner/name` | — | One repository, regardless of staleness |

Cheap: unchanged repositories answer `304 Not Modified` and cost no quota at all.

> With more than 1,000 repositories, one pass will not cover them. Run it twice.

### `sync issues`

Pulls open issues. The first run for a repository is a full backfill; after that it fetches only what
changed.

```bash
npm run compass -- sync issues --limit 100
npm run compass -- sync issues --repo owner/name
npm run compass -- sync issues --backfill-max-pages 5
```

| Flag | Meaning |
|---|---|
| `--limit N` | How many repositories to process |
| `--repo owner/name` | One repository only |
| `--backfill-max-pages N` | Page cap for a repository's first full pull, so one huge tracker cannot eat a whole run |
| `--incremental-max-pages N` | Page cap for later incremental passes |

The slowest step. 100 issues per request.

### `sync metrics`

**The step that makes the ranking meaningful.** Reads external pull requests and derives whether
maintainers review outside work, how fast, and how often they merge it.

```bash
npm run compass -- sync metrics --limit 100
npm run compass -- sync metrics --repo owner/name
npm run compass -- sync metrics --stale-days 0     # recompute everything
```

| Flag | Default | Meaning |
|---|---|---|
| `--stale-days N` | 7 | Skip repos measured more recently. Maintainer behaviour moves slowly, so a week-old metric is still good |
| `--limit N` | all | How many repositories |
| `--repo owner/name` | — | One repository |
| `--window-days N` | 180 | How far back to look for external PRs |
| `--pr-count N` | 40 | Pull requests to examine per repository |
| `--batch-size N` | 5 | Repositories per GraphQL request |
| `--grace-days N` | 7 | Open, unanswered PRs older than this count as ignored |

Uses GraphQL, so it is efficient per repository but the queries are large.

### `sync setup`

Reads each repository's root files — compose files, env templates, task runners, CI config — and
derives a `light` / `moderate` / `heavy` verdict.

```bash
npm run compass -- sync setup --limit 100
npm run compass -- sync setup --stale-days 0
```

| Flag | Default | Meaning |
|---|---|---|
| `--stale-days N` | 30 | Skip repos read more recently. Layout changes slowly |
| `--limit N` | all | How many repositories |
| `--repo owner/name` | — | One repository |
| `--batch-size N` | 3 | Repositories per request. Kept low because this returns file contents |

> Reads **root-level files only**. A project keeping its compose file in a subdirectory will read as
> simpler than it is. See [Roadmap](roadmap.md).

### `sync all`

Runs `repos`, `issues`, `metrics`, then `setup` in order.

```bash
npm run compass -- sync all
```

Convenient, but it can run for hours. Prefer the individual commands with `--limit` until you know how
long each takes on your corpus.

---

## Finding work

### `shortlist`

The ranked list, with the evidence for each row.

```bash
npm run compass -- shortlist
npm run compass -- shortlist --min-score 0                       # include weak candidates
npm run compass -- shortlist --language Python --max-setup light
npm run compass -- shortlist --labelled --min-stars 1000 --max-stars 30000
npm run compass -- shortlist --per-repo 5 --limit 40
```

| Flag | Default | Meaning |
|---|---|---|
| `--limit N` | 20 | Rows to show |
| `--min-score N` | 20 | Score threshold. Can be 0 or negative |
| `--per-repo N` | 2 | Most rows from any one repository |
| `--language X` | any | Primary language. Case-insensitive — `python` and `Python` both work |
| `--labelled` | off | Only issues carrying an invitation label |
| `--max-setup light\|moderate` | any | Setup ceiling |
| `--min-stars N` | any | Star floor |
| `--max-stars N` | any | Star ceiling |
| `--include-dormant` | off | Include projects where nobody answers outside PRs |

**Why `--per-repo` exists.** Repository-level signals dominate the score, so without a cap one good
project takes over the list. On a real run, twelve of the top twenty came from the same repository, all
on an identical score.

Assigned, locked, and already-judged issues are excluded outright — they are someone else's work, not a
weak option.

### `why`

The full itemised breakdown for one issue.

```bash
npm run compass -- why facebook/react#12345
```

Output is split into "the project" and "this issue", each line carrying the raw value behind it, then
a list of anything that could not be measured.

Works on issues the shortlist *rejected*, which is most of the reason to use it. If it says the issue
is not a current candidate, it is closed, assigned, already judged, or in a repository you have not
synced.

---

## Recording decisions

This is the part that turns the tool from a guess into a measurement. Skipping it is why the weights
are still unvalidated.

### `decide`

```bash
npm run compass -- decide owner/name#123 started --hours 4
npm run compass -- decide owner/name#123 merged --actual-hours 9
npm run compass -- decide owner/name#456 rejected --reason "needs a design discussion first"
```

Verdicts:

| Verdict | Means |
|---|---|
| `shortlisted` | Worth doing, not started |
| `started` | Working on it now |
| `submitted` | Pull request opened, waiting on review |
| `merged` | Merged |
| `stalled` | Open but going nowhere |
| `abandoned` | Started and dropped |
| `closed_unmerged` | Closed without merging |
| `rejected` | Not worth doing |

| Flag | Meaning |
|---|---|
| `--hours N` | How long you **expect** it to take. Record when you start |
| `--actual-hours N` | How long it **did** take. Record when you finish |
| `--reason "..."` | Free text. This is the part you will reread |

Any verdict removes the issue from future shortlists. Record several over time for the same issue —
they accumulate into a trail, and `--hours` plus a later `--actual-hours` form the pair the calibration
figure is built from.

### `journal`

What you decided, and how your estimates compared to reality.

```bash
npm run compass -- journal
npm run compass -- journal --limit 10
```

The average estimate error appears only once **three** issues have both a prediction and an outcome.
Below that it says how many you have. This is deliberate: an average over one or two ratios is exactly
the false precision the tool refuses everywhere else.

---

## Corpus reports

These have no web equivalent yet. They exist to interrogate the measurements rather than the ranking.

### `maintainers`

Repositories sorted by how they treat outside contributors.

```bash
npm run compass -- maintainers --sort median --limit 20
npm run compass -- maintainers --bucket responsive --min-prs 10
```

| Flag | Meaning |
|---|---|
| `--sort median\|ignored\|stale\|reviewed\|merge` | Sort key |
| `--limit N` | Rows |
| `--min-prs N` | Only repositories with at least this many external PRs measured |
| `--bucket dormant\|slow\|moderate\|responsive` | One responsiveness bucket |

### `explain`

The per-pull-request evidence behind one repository's metrics. Use this when a number looks wrong.

```bash
npm run compass -- explain facebook/react
```

### `responders`

Who actually answers external pull requests. **Exposes bot first-responders** — an account with dozens
of responses at a near-zero median is automation, and counting it as maintainer attention both flatters
the median and hides the true ignore rate.

```bash
npm run compass -- responders --limit 30
npm run compass -- responders --repo owner/name
```

When you find one, add it to `COMPASS_IGNORE_LOGINS` — see [Configuration](configuration.md).

### `setup`

Repositories sorted by what it costs to get them running.

```bash
npm run compass -- setup --sort weight --limit 20
npm run compass -- setup --weight heavy --max-services 3
```

| Flag | Meaning |
|---|---|
| `--sort weight\|services\|env\|runtime` | Sort key |
| `--weight light\|moderate\|heavy` | One bucket |
| `--max-services N` | Cap on compose service count |
| `--limit N` | Rows |

### `status`

Corpus counts, recent runs, and how much of your GitHub allowance they used.

```bash
npm run status
```

The first thing to run when something looks wrong.

---

## Housekeeping

### `prune`

Pauses repositories not worth syncing issues from, so later runs spend their budget on projects that
might actually produce a candidate. **Dry run by default.**

```bash
npm run compass -- prune --dormant                    # show what would be paused
npm run compass -- prune --dormant --apply            # actually pause them
npm run compass -- prune --heavy --min-confidence high --apply
npm run compass -- prune --unpause --apply            # undo everything
```

| Flag | Meaning |
|---|---|
| `--dormant` | Repositories where nobody answers external PRs |
| `--heavy` | Repositories with heavy setup cost |
| `--min-confidence medium\|high` | Only act where the measurement has a real sample behind it |
| `--apply` | Actually make the change. Without this, nothing is written |
| `--unpause` | Restore every paused repository to active |

Reversible by design: pausing sets a flag, it does not delete anything.

---

## The server

### `serve`

Starts the JSON API and serves the web interface.

```bash
npm run serve
npm run compass -- serve --port 3000
npm run compass -- serve --host 0.0.0.0    # think first, see below
```

| Flag | Default | Meaning |
|---|---|---|
| `--port N` | 8787 | Port. Also settable via `COMPASS_PORT` |
| `--host X` | 127.0.0.1 | Interface. Also settable via `COMPASS_HOST` |

> **Localhost by default, on purpose.** There is no authentication, and `POST /api/decisions` writes to
> your database. Binding `0.0.0.0` puts an unauthenticated write endpoint on your network.

The web interface is served only if it has been built. `npm run web:build` does that, and `npm start`
does both in one step.

---

## Flags that appear everywhere

| Flag | Applies to | Meaning |
|---|---|---|
| `--limit N` | all sync and report commands | How much to process or show |
| `--repo owner/name` | all sync commands, `explain`, `responders` | One repository |
| `--help`, `-h` | anywhere | Print the command summary |

Two conventions worth knowing:

- **`--limit` must be positive.** A limit of zero is meaningless, so it is rejected rather than
  silently treated as "no limit".
- **Staleness flags accept zero**, meaning "refresh everything now" — `--stale-days 0` is a legitimate
  and useful instruction.

Bad values are refused with a message rather than coerced. `--limit banana` is an error, not a
silently-ignored flag.
