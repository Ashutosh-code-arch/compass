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

### `add`

Adds a project you care about, and makes it rankable.

```bash
npm run compass -- add django/django
npm run compass -- add https://github.com/django/django     # a pasted URL works
npm run compass -- add django/django --metadata-only        # just the row, no scans
```

| Flag | Meaning |
|---|---|
| `--metadata-only` | Fetch the repository row only, leaving issues, metrics and setup for later |

By default this also pulls the project's issues, measures its maintainer attention, and reads its setup
cost — because adding a project and then being shown nothing would be a strange thing to offer. For one
repository that is only a handful of requests.

Two things worth knowing:

- **A manually added project is never paused by `prune`.** Otherwise `prune --dormant` would quietly
  undo what you just asked for.
- **Discovery is not required first.** Before this command existed, the corpus was whatever the seed
  searches happened to find, and `sync repos --repo django/django` matched nothing and reported
  `Nothing to refresh` — which reads like success.

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

Reads each repository's files — compose files, env templates, task runners, CI config, CONTRIBUTING —
and derives a `light` / `moderate` / `heavy` verdict, plus any CLA or DCO requirement.

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

> Reads the **whole file tree** since migration 008, so a project keeping its compose file in
> `build/` or its env template in `config/` no longer reads as simpler than it is. Root-level facts
> (Makefile, lockfiles) still come from the root deliberately, so the change did not re-score the
> corpus for unrelated reasons. A tree GitHub truncated yields `unknown`, never a confident verdict.
>
> Also reports a **CLA or DCO** requirement, found in CONTRIBUTING (root, `.github/` or `docs/`) and
> in CLA/DCO bot configuration. `none` is only reported when a CONTRIBUTING file was actually read —
> otherwise the answer is unmeasured, because a confident "no CLA" that walks you into a signature
> wall is worse than no answer.

### `sync all`

Runs `repos`, `issues`, `metrics`, then `setup` in order.

```bash
npm run compass -- sync all
```

Convenient, but it can run for hours. Prefer the individual commands with `--limit` until you know how
long each takes on your corpus.

---

## Finding work

### `orgs`

The organisation table: **which organisations are worth your time**, asked before which issue.

Every competitor lists issues carrying a label. None of them measures whether maintainers merge work
from outsiders — which is what the three middle columns here are, and the only reason this table can
exist.

```bash
npm run compass -- orgs
npm run compass -- orgs --gsoc 2026                  # only GSoC participants
npm run compass -- orgs --gsoc 2026 --uncovered      # …that you have never measured
npm run compass -- orgs --sort candidates --limit 20
```

| Flag | Default | Meaning |
|---|---|---|
| `--sort attention\|candidates\|name` | `attention` | Ordering. An unknown value is refused, not ignored |
| `--gsoc YEAR\|any` | any | Only organisations tagged as GSoC participants. A four-digit year or `any` |
| `--language X` | any | Modal primary language, matched case-insensitively |
| `--min-repos N` | any | Drop organisations with fewer repositories in the corpus |
| `--momentum hype\|rising\|steady\|cooling` | any | The organisation's modal momentum verdict |
| `--uncovered` | off | Only organisations with **no** repositories in the corpus |
| `--limit N` | 50 | Rows to show |
| `--offset N` | 0 | Rows to skip |

```
Organisation              Maintainers reply?          Merge rate       Setup                 Open    GSoC
─────────────────────────────────────────────────────────────────────────────────────────────────────────
hog                       responsive · 9h             86% of 14        1 light               6       2026
acme                      slow 1/2 · 34h              76% of 37        1 light 1 mod         5       2026
                          CLA in 1 of 2 repos — resolve before writing code
cern-hsf                  not in corpus               —                —                     0       2026
```

**Nothing here is a score.** The ordering is an ordinal cascade — verdict, then merge rate, then how
much work is actually available, then name — so any position can be explained by pointing at a column.
A composite number would be a fifth invented measurement and would hide the tradeoff you are here to
make.

Read the columns as follows:

- **The verdict is modal** across an organisation's *measured* repositories, with the count shown
  (`slow 1/2`). Ties break toward the worse verdict: being told an organisation replies when half of it
  does not costs an evening, while the reverse costs a second look.
- **Median reply is a median of per-repository medians.** It describes the typical repository, not the
  typical pull request.
- **Merge rate is pooled, not averaged,** and always carries its denominator. `100% of 2` and
  `76% of 37` are not the same claim.
- **Setup is a distribution.** These are ordinals; averaging them would invent a number. It sums to
  fewer than the repository count when some have not been read.
- **`not in corpus`** is a real row. It means the organisation came from a curated list and nothing
  about it has been measured — which is exactly the list to run [`add`](#add) against.

**Momentum** is growth crossed with the ability to absorb it, and the column that makes this table worth
more than a star ranking:

| Verdict | Meaning | What it means for you |
|---|---|---|
| `hype` | Surging, and the measurements say nobody can review the result | The worst place to spend five hours, and the one every star-ranked list puts at the top |
| `rising` | Surging, and maintainers are demonstrably reading outside work | The best place to be early: visible project, active mentors, and your pull request lands |
| `steady` | Growing normally | Most good projects, most of the time |
| `cooling` | Losing stars, or gaining none across the window |  |
| `—` | **Unmeasured**, never "not growing" | Needs two star samples a week or more apart |

`hype` is never reached from growth alone. "This project is popular" is not a criticism, and a verdict
amounting to one would be the tool substituting taste for measurement — so it also requires a measured
capacity concern: dormant or slow replies, a queue of 100+ open pull requests, or a merge rate at or below
40% over at least ten decided pull requests.

Dormant organisations are shown by default, unlike the shortlist, which excludes dormant repositories
outright. That is deliberate: "this GSoC organisation has 40 open issues and has not replied to an
outsider in 31 days" is the most valuable row this table can produce.

Drill in with `shortlist --org <login>`.

### `gsoc import`

Tags organisations as GSoC participants for a year, from a hand-checked file.

```bash
npm run compass -- gsoc import gsoc-2026.txt --year 2026 --source "official list, read 2026-08-04"
npm run compass -- gsoc import gsoc-2026.txt --year 2026 --source "…" --replace
```

| Flag | Default | Meaning |
|---|---|---|
| `--year N` | — | **Required.** The programme year |
| `--source "…"` | — | **Required.** Where the list came from |
| `--replace` | off | Delete that year's existing tags first, after the file validates |

The file is one **GitHub login** per line. `#` starts a comment, blank lines are ignored, `owner/name`
reduces to `owner`, and duplicates collapse.

```
# GSoC 2026, mapped by hand from the official list
python          # Python Software Foundation
cern-hsf
postgres/postgres
```

**Why a file and not a fetch.** The published list carries *programme* names — "Python Software
Foundation", "CERN-HSF" — which are not GitHub logins. Something has to map one to the other, and no
scraper does that reliably. A human doing it once a year is what the `curated` provenance class means.

**`--source` is required, not defaulted.** A curated value with no provenance is indistinguishable from
a measurement, and it is the kind that goes stale without anyone noticing. `reviewed_at` is stamped
with today automatically and cannot be omitted.

**Two things are refused rather than imported:**

- **An empty file.** A changed page, a failed download, or a wrong path all produce one, and accepting
  it would record "no organisation participates in GSoC" — a false finding, which is worse than a gap.
  This is the same rule as `null` never meaning `0`.
- **A file where more lines fail to parse than succeed.** An HTML dump or a list of programme names
  would otherwise import the handful of lines that happened to look like logins, producing a plausible,
  dated, wrong claim.

Organisations not already in the corpus are **created** as identity-only rows rather than skipped, and
the command reports how many. That count is the point of the import:

```
GSoC 2026: 5 organisation(s) tagged.
3 organisation(s) were new to the corpus and now exist as rows.

3 of them have no repositories in your corpus, so nothing about them is measured yet.
```
### `ross import`

Ingests a ROSS Index dataset: which organisations are growing fastest, and who funds them.

```bash
npm run compass -- ross import ross-2026q1.csv --quarter 2026Q1 --source "RunaCapital/ROSS-Index, read 2026-08-04"
```

| Flag | Default | Meaning |
|---|---|---|
| `--quarter Q` | — | **Required.** The dataset's quarter, e.g. `2026Q1` |
| `--source "…"` | — | **Required.** Where the dataset came from |

Runa Capital publishes the index as datasets in a git repository (`RunaCapital/ROSS-Index`), already
joined: organisation, `owner/repo`, stars, growth multiple, founding year, location, and funding including
YC. No scraping, no terms-of-service question, no brittle selectors. See
[`fixtures/ross-index.example.csv`](../fixtures/ross-index.example.csv) for the shape.

**Columns are matched by name, not by position.** A positional parser would read growth multiples as star
counts the first time somebody inserted a column, and nothing in the output would look wrong. The command
prints which column it read for each field so a surprising import can be explained rather than re-guessed.

**Growth is deliberately not imported.** Compass measures that itself from `repo_stars_history`, and
storing somebody else's growth figure beside its own would create two numbers for one question with no way
to tell which you were looking at. What the import contributes is the two things the corpus cannot derive:
**funding**, and **who is on the list at all** — a discovery feed rather than a signal.

Everything written is **curated**: somebody else's numbers, on their date, stored with a `reviewed_at`
saying so. Refusals match [`gsoc import`](#gsoc-import) — an empty dataset, a file with no recognisable
owner column, or one where more rows fail than parse.

Repositories named by the dataset that are absent from the corpus are reported as `add` commands. Until
they are added, nothing about them is measured.


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
| `--stack X` | any | **What the project is built with**: `react`, `django`, `js`. See below |
| `--language X` | any | Primary language, matched exactly (case-insensitively). The strict form |
| `--labelled` | off | Only issues carrying an invitation label |
| `--max-setup light\|moderate` | any | Setup ceiling |
| `--min-stars N` | any | Star floor |
| `--max-stars N` | any | Star ceiling |
| `--include-dormant` | off | Include projects where nobody answers outside PRs |
| `--org login` | any | One organisation. The drill-down from [`orgs`](#orgs) |
| `--exclude-claimed` | off | Drop issues a [claim check](#claims) found taken. Unchecked issues stay in |
| `--momentum hype\|rising\|steady\|cooling` | any | Growth crossed with review capacity. **Excludes repositories whose velocity is unmeasured** |
| `--weights career-leverage` | default | Score against a named weight set for this run only, without changing the saved profile |

**`--stack` matches evidence, not names.** It reads declared dependencies (`package.json`,
`pyproject.toml`, `requirements.txt`, `go.mod`, `Cargo.toml`, `pom.xml`) plus GitHub topics. A repository
called `awesome-react-tips` is not a React project and will not match; one that declares `react` as a
dependency will, whatever it is called.

```bash
npm run compass -- shortlist --stack react
npm run compass -- shortlist --stack django
npm run compass -- shortlist --stack js        # JavaScript *and* TypeScript projects
```

`--stack js` and `--stack javascript` both include TypeScript, because someone looking for JavaScript
work will nearly always take a TypeScript project. `--stack ts` stays narrow, because the implication
only runs one way. When you want strictly one language, `--language JavaScript` is exact.

An unrecognised term matches **nothing** rather than everything. `/api/stacks` lists what your corpus
actually contains, and the web interface offers it as a dropdown.

> Frameworks come from the setup scan. Until `sync setup` has run, `--stack react` will find only
> projects carrying a matching GitHub topic.

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
### `claims`

Is this issue **actually free**? Reads the comment thread and gives a dated verdict.

```bash
npm run compass -- claims acme/widgets#412
npm run compass -- claims acme/widgets#412 --cached    # reuse an earlier check
```

| Flag | Default | Meaning |
|---|---|---|
| `--cached` | off | Return an earlier verdict instead of fetching |

The problem it solves: a `good first issue` with 23 comments is usually twenty people asking "can I work
on this?" and one person three days in without an assignment. GitHub's assignee field is empty in every
one of those cases, so the shortlist — which correctly excludes *assigned* issues — treats the whole pile
as free work. It is the largest remaining way this tool can waste an evening.

| Verdict | Meaning | What to do |
|---|---|---|
| `in-progress` | Somebody reported actual work, or a pull request is linked | Skip it. A second pull request helps nobody |
| `contested` | Several people asked and nobody was assigned | The evening-waster. Unless you want to race, go elsewhere |
| `claimed` | One recent request, nobody assigned | Comment before you start |
| `stale-claim` | A request went quiet for longer than an intention survives, about a fortnight | Probably yours. Say so in the thread |
| `free` | Nobody asked | Nothing in the thread suggests anyone else is on it |

**A verdict is true as of the moment it was made**, and is always printed with its age and its coverage.
`free` from three weeks ago, read from 100 comments of a 412-comment thread, is a much weaker claim than
a fresh check that read everything — and only the age tells you which you have.

**Costs one request**, and only when the issue has comments; a thread with none is answered from the
corpus without touching the network. Results are cached, so a later `shortlist` shows what you already
know for nothing, and `--exclude-claimed` can act on it.

**What is deliberately not a claim.** Each of these appears constantly in issue threads and each would
match otherwise:

- *"Is anyone working on this?"* — a question about other people's claims
- *"@ada can you take this one?"* — delegation, usually from a maintainer
- *"Are you still working on this?"* — a maintainer chasing a stale claim
- *"I'll take a look"* — looking is not doing
- *"You can use /assign me to claim issues here"* — instructions, not intent

A claim must be first-person and volitional. *"I would like to work on this if nobody else is"* **is** a
claim, deliberately: that person is volunteering, and treating it as a question would produce a false
`free`, which is the expensive direction to be wrong in.

Nothing here changes the score. See [How ranking works](how-ranking-works.md).


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
