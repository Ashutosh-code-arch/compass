# Roadmap

What is built, what is next, and in what order.

**Read the [sequencing note](#the-one-sequencing-constraint-that-matters) before reordering anything.**

---

## What this is becoming

A **personal research desk for open-source contribution**, for one person and a few friends. Not a
platform, not multi-user, not hosted. That decision simplifies a great deal — see
[Deliberately dropped](#deliberately-dropped).

Three questions, in the order they are actually asked:

1. **Which organisations are worth my time?** — the layer that does not exist yet
2. **Within those, which issue is genuinely free and worth this evening?** — the existing shortlist,
   plus current-state signals
3. **Was I right?** — the journal, as personal calibration

Every value shown belongs to one of three provenance classes, and they are never blurred:

| Class | Examples | Trust |
|---|---|---|
| **Measured** | responsiveness, merge rate, setup cost, star velocity | Yours, dated, defensible |
| **Curated** | funding, YC, GSoC participation, market tags | A human list. Must carry a review date |
| **Current state** | claims, PR queue depth, unclaimed age, bounties | Decays. Refetch or mark stale |

---

## Built

| | Status |
|---|---|
| Corpus discovery, issue sync, incremental backfill | Working |
| Maintainer attention metrics | Working; corrected through six rounds against a 1,000-repo corpus |
| Setup complexity, full file tree | Working |
| Framework detection (`--stack react`) | Working, 34 entries |
| Ranking with itemised breakdowns | Working |
| Decisions journal and calibration | Working |
| `add owner/name` | Working |
| Skills profile, reputation gate | Working |
| JSON API, React UI (4 screens) | Working |
| Pagination, language picker, sync from UI, first-run guidance | Working |
| `prune` | Working |
| Docs + `npm run docs:check` | Working |
| **Phase 0**: star history, organisations, rejection patterns, CLA/DCO | **Working** |
| **Phase 1**: the org layer, the GSoC wedge, `--org` drill-down | **Working** |
| **Phase 2**: claim detection, queue depth, quiet age, bounty labels | **Working** |
| **Phase 3**: star velocity, the hype filter, ROSS ingestion, weight sets | **Working** |

370 tests, 13 migrations, ~17,000 lines TypeScript plus the React app.

---

## The one sequencing constraint that matters

**Star velocity needs elapsed time.** A `repo_stars_history` row is worthless on the day you create
it; the signal only exists once two samples sit weeks apart. So the migration lands in **Phase 0**
even though the feature it feeds does not arrive until **Phase 3**.

Get that wrong and Phase 3 starts with an empty table and a three-month wait.

**This is done.** Migration 009 exists and every sync path writes to it, so the clock is running from
the moment you migrate — and the migration backdates a first sample from `repos.stars` at
`meta_synced_at`, which means an existing corpus starts with real dated history rather than from zero.

Everything else can be reordered freely.

A second, softer deadline: GSoC 2027 organisations are announced around **February 2027**, and the
contributions that matter land in the months *before* that. The Phase 1 wedge wants to be usable by
roughly **October 2026**. The 2026 list of 185 organisations is public now and is highly predictive of
next year's, so there is real data to work with today.

---

## Phase 0 — Foundations, and the clock starts — DONE

Nothing user-visible except one small win. **Zero new API cost**, as planned: the only new fetch is one
extra blob slot in a GraphQL request that was already being made.

Four things landed, in three migrations. Two deliberate deviations from the plan below are marked.

**1. Migration: `repo_stars_history`** — done, migration 009.

Written by `sync repos`, `seed`, and `add` — every path that learns a star count. One row per repo per
**UTC day** rather than per sync: instants would let sync frequency masquerade as sampling quality, so
the primary key holds the resolution and `src/sync/stars.ts` is the single place that decides it.

`sync repos` records on **304s too**. An unchanged ETag covers the whole representation including the
star count, so GitHub has just confirmed the figure is current — and recording it keeps history dense
for the quiet end of the corpus instead of leaving those repos with one ancient sample and no
computable velocity.

Velocity is then `stars now − stars at the oldest sample inside the window`, per repo, and it is
**measured**, dated, and yours. It also covers repos no external index lists. Coverage is visible on
`status` and the corpus screen, because a table filling up invisibly is one somebody later decides to
build again.

**2. Migration: `organizations` + `org_tags`** — done, migration 010.

`organizations` is **identity only**, backfilled from distinct `repos.owner` and dated from
`min(discovered_at)` rather than from migration time. Kept in step by `refreshOrganizations()`, one
statement called at the end of `seed`, `sync repos` and `add`.

No measured value is copied into it. Rollups stay computed on read, so a stored number can never
silently disagree with the metrics it claims to summarise.

**Deviation:** `org_tags` is a tall table — one row per claim, `(org_login, kind, value)` — not array
columns on one row. A single `reviewed_at` cannot say when *each* value was checked, and "GSoC 2024,
2025, 2026" reviewed last February means something different from the same list reviewed today. The
requirement was a review date on every curated value, so the shape follows the requirement rather than
the sketch. `reviewed_at` is `not null`: there is no way to add a curated value without dating it.

**3. Rejection patterns (the free win)** — done, `src/rank/patterns.ts`.

Grouped per **issue**, not per journal row: `started → abandoned` is one abandonment, and counting rows
would report it as two. Two counts rather than one, because they are different warnings — `declined`
(you looked and chose not to start, usually about how the project files issues) and `unlanded`
(abandoned, closed unmerged, or stalled — what happens after you push, the more expensive kind of
wrong).

Shown on the shortlist row and in the breakdown, worded as a report of what you did rather than as
advice. **Never scored.** Judged issues are already gated out, so this describes the project rather
than the candidate, and folding a handful of hand-written notes into the weights would mean the ranking
learns from something nobody has validated. Six past rejections are a fact about you, not a forecast
about the seventh issue.

Reasons group by normalise-then-exact-match — lowercase, collapse whitespace, strip trailing
punctuation. Nothing stemming-like, because anything cleverer would start merging genuinely different
reasons with no way to tell from the output that it had happened.

**4. CLA / DCO detection** — done, migration 011 and `src/setup/agreement.ts`.

CLA and DCO are recorded **separately**, with `both` as a real answer: a signature that may need an
employer's involvement is not the same size of obstacle as one flag on a commit, and that is the only
distinction that changes what you do next.

`findContributing` allows `docs/` where the compose search must not, and prefers root, then `.github/`,
then shallowest. `has_contributing` is untouched and stays a root-only fact, so this did not re-score
the corpus.

The rule the module turns on: **`none` only when a CONTRIBUTING file was actually read.** No readable
file and no bot configuration means null, because the usual place a project states this was not there
to look at. Positive findings survive a truncated tree; only absence is withheld — the same asymmetry
as `classifySetupWeight`.

Two false positives were specifically designed out, both caught by tests: a bare "sign off" (a
maintainer signing off on a design is not a DCO) and substring filename matches (`declarations.yaml`
contains "cla", `mdco.py` contains "dco").

**Also fixed, found by an existing guard:** the `RUN_KINDS` drift test searched every migration for
`check (kind in (...))` on the assumption that only one table had a column called `kind`, so adding
`org_tags.kind` made it fail and blame the new migration for a fault in itself. It is now table-scoped,
via `src/schema_constraints.ts`, and two more guards use the same reader — `ORG_TAG_KINDS` and
`AGREEMENT_KINDS`.

---

## Phase 1 — The org layer and the GSoC wedge — DONE

The actual gap: what answers "I do not know which organisations exist."

**1. Org-level view** — done. `orgs` on the CLI, `GET /api/orgs`, and a "Who to work with" screen.
`shortlist --org <login>` is the drill-down, so the organisation is now the primary object and the
shortlist is what you open from it.

The four combining decisions all live in `src/org/view.ts`, which is PURE — a query full of
`mode() within group` and pooled ratios would have put four judgements where no fixture can reach them,
and a thousand repositories is nothing to aggregate in memory.

| Value | Combination | Why not the obvious thing |
|---|---|---|
| Verdict | **Modal** across measured repos, ties broken toward the worse | Not the worst (one dormant repo in forty is not a dormant organisation) and not the best (that is how a marketing page describes itself) |
| Median reply | Median of per-repository medians | The typical *repository*, not the typical pull request. The field is named `medianRepoHoursResponse` so that cannot be forgotten |
| Merge rate | **Pooled**, with the denominator shown | Averaging per-repo rates lets a repo with two decided PRs outvote one with two hundred |
| Setup | A **distribution** | Averaging `light`/`moderate`/`heavy` invents a number from an ordinal |

Ordering is a documented ordinal cascade, **not a composite score**: verdict, merge rate, available
work, name. Unmeasured organisations sort last — a list is a recommendation whatever you call it.

Dormant organisations are shown by default, unlike the shortlist. "This GSoC organisation has 40 open
issues and has not replied to an outsider in 31 days" is the most valuable row the table can produce,
and a shared dormant filter would have hidden exactly that.

**Correctness precondition, done first:** the rollup counts open candidates and the shortlist defines
what a candidate is. Those are now one shared SQL fragment, `CANDIDATE_GATES`, with a test asserting
both queries interpolate it. Two copies would have meant a row promising six candidates that opens onto
four, with nothing anywhere explaining why.

**2. GSoC organisation ingestion** — done, as an importer rather than a shipped list.

`gsoc import <file> --year N --source "..."`. The list is **not** bundled, and this is deliberate: the
published list carries programme names ("Python Software Foundation", "CERN-HSF") which are not GitHub
logins, and nothing can map one to the other reliably. A human doing it once a year is what `curated`
means. Writing a list from memory would have been fabricating dated curated data, which is the failure
this project is most careful about.

`--source` is required rather than defaulted, `reviewed_at` is stamped automatically, and two things
are refused rather than imported: an **empty file** (a failed download recording "nobody participates"
is a false finding, not a gap — the `null` ≠ `0` rule again) and a file where **more lines fail to parse
than succeed** (an HTML dump would otherwise import the few lines that happened to look like logins).

Organisations absent from the corpus are created as identity rows rather than skipped, which produces
the actionable output: `orgs --gsoc 2026 --uncovered` is the list to run `add` against.

**3. The wedge itself** — done. One table nobody else can produce:

```
Organization       Mentors reply?              Merge rate   Setup     GSoC
──────────────────────────────────────────────────────────────────────────
CERN-HSF           responsive · 8h median      74%          moderate  2024–26
some-other-org     dormant · no reply in 31    —            light     2026
```

A student picking from the official list sees a description and some tech tags. They cannot find out
whether anyone will read their PR. You already own the only engine that measures it.

**4. A calendar-aware line, not a tab** — done, `gsocOutlook(now)`, PURE with four phases and a test
for every transition plus one asserting all 365 days produce a message.

Only 2026's dates are published, so every later year is flagged `estimated: true` wherever it surfaces.
Presenting an inferred February date as fact would be the same kind of confident-but-unverified claim
refused everywhere else.

A dark "coming soon" tab would have been dead UI for eight months and would teach exactly the wrong
behaviour, since the useful window is **before** the announcement.

---

## Phase 2 — Current state, so picking an issue stops wasting evenings — DONE

Phase 1 tells you where. This makes choosing *within* an org reliable.

**One decision governs the whole phase: it adds five facts and no weights.**

Two reasons, and the second is the real one. A claim verdict exists only for issues somebody has
checked, so scoring it would order two identical issues differently according to how requests had been
spent — the ranking would encode your fetch history. And more importantly, **not one weight in
`weights.ts` has been validated against an outcome yet**. Adding six more unvalidated numbers would not
make the ranking better; it would make it harder to tell whether it works at all. Everything here is
shown next to the score, with its age, and the reader decides. `view.test.ts` asserts current state does
not move the score.

**1. Claim detection** — done. `src/claims/detect.ts` (PURE), `claims owner/name#123`,
`POST /api/issues/:owner/:name/:number/claims`, and a button on the expanded row. On demand only, one
request per issue, and none at all when the thread is empty.

Five verdicts with a documented authority order: `in-progress` beats everything (somebody with work in
flight settles it), `contested` beats `claimed` (several volunteers and nobody assigned means the
maintainers are not managing assignment at all, which is the specific trap), and `stale-claim` marks a
request that went quiet for longer than an intention survives — about a fortnight — so the issue is
probably free again.

The phrasing rules are narrow and stated rather than fuzzy, because the two ways of being wrong cost
differently. A false `claimed` loses you an option you never learn about; a false `free` costs you an
evening and you find out at the worst moment. So a claim must be **first-person and volitional**, and
these are all tested as non-claims: *"is anyone working on this?"* (a question about other people's
claims), *"@ada can you take this?"* (delegation), *"are you still working on this?"* (a maintainer
chasing a stale claim), *"I'll take a look"* (looking is not doing), and *"you can use /assign me to
claim issues here"* (instructions — found by a failing test, since the sentence contains the exact
phrase the rule looks for). *"I would like to work on this if nobody else is"* deliberately **is** a
claim: that person is volunteering, and reading it as a question would produce the expensive error.

Results are cached with `checked_at`, so a later shortlist shows what you already know for nothing —
and `--exclude-claimed` acts on it, dropping only what was checked and found taken. **No row means never
checked, which is not `free`**, and nothing in the CLI or the UI renders it as though it were.

**2. Unclaimed age** — done, as `quietDays`: days since anything happened on the issue. Free, from
timestamps already stored. Shown past thirty days, because below that it says nothing.

**3. PR queue depth** — done, riding along in the metrics GraphQL request for **no extra call**.

Not a filter over the existing PR window: that window is the 40 most recent pull requests, so counting
open ones inside it would report "40" for a repository with 900 and be indistinguishable from one that
really has 40. A separate filtered connection gives an exact `totalCount`, plus the oldest open pull
request — because a queue of 200 that turns over weekly and a queue of 12 whose oldest has waited three
years are different projects and the count alone cannot tell them apart.

**A collision caught while doing it:** `open_prs` already existed and means open **external** pull
requests inside the sampled window — the denominator for `open_stale_rate` and therefore for the
dormancy rule. Reusing the name would have merged two facts used for opposite purposes. The new column
is `open_pr_total` and both now carry SQL comments saying which is which.

**4. Bounty detection** — done. Labels cost nothing and are available for every issue, not just the ones
you open; comment hints come along with a claim check. Deliberately narrow: `help wanted` is not a
bounty, and neither is `paid-plan`, which is a product label on plenty of SaaS repositories.

---

## Phase 3 — Momentum and the discovery feed — DONE

`repo_stars_history` has been filling since Phase 0, and this is the phase that finally reads it. Velocity
cannot be backfilled — two samples a week apart is a fact you either have or do not — so every day between
Phase 0 and here is what made this possible. **This is the first genuinely new measurement since the
responsiveness engine.**

**1. Star velocity** — done, `src/velocity/compute.ts` (PURE), shown per repository on the shortlist and
per organisation in the org table.

Honest in every direction it can be wrong. Fewer than two samples, or a span under a week, returns **null
rather than zero**: two samples a day apart differ by whatever happened to be trending on that day, and
dividing by a span of one produces a per-day rate less precise than the answer it states. A zero baseline
gives a null multiple rather than an enormous one. Losing stars is reported as a loss, not clamped.

Both the absolute rate and the relative multiple count as growth, because they catch different projects:
the rate finds the thing on the front page this month, and the multiple finds a small project tripling from
four hundred stars, which is the same phenomenon at a scale the rate would miss.

The query aggregates to the **two endpoints plus a count**, not every row — a ninety-day window over a
thousand repositories is tens of thousands of rows fetched to use two of them per repository, and this
project has already paid once for a query that scaled with the corpus rather than with the answer. Both
callers go through one pure implementation so the rules cannot drift.

**2. ROSS Index ingestion.** Runa Capital publishes the datasets as a git repo
(`RunaCapital/ROSS-Index`), already joined: org, `owner/repo`, stars, growth multiple, founding year,
location, and funding including YC. **No scraping, no ToS question, no brittle HTML.** Pull quarterly,
`add` anything new. Roughly twenty lines, not a data platform.

**3. The hype filter** — done, and it works. Four verdicts:

| Verdict | Meaning |
|---|---|
| `hype` | Surging, and the measurements say nobody can review the result |
| `rising` | Surging, and maintainers are demonstrably reading outside work |
| `steady` | Growing normally |
| `cooling` | Losing stars, or gaining none |

**`hype` is never reached from growth alone.** "This project is popular" is not a criticism, and a verdict
amounting to one would be taste dressed as measurement — so it also requires a measured capacity concern:
dormant or slow replies, a hundred or more open pull requests, or a merge rate at or below 40% over at
least ten decided ones.

The live proof that this is worth having: in testing, a repository came out `hype` while its
responsiveness read **responsive**, because the capacity concern was its 214 open pull requests with the
oldest waiting 840 days. Fast replies and a queue that never moves is exactly the combination a star
ranking cannot see and a single responsiveness verdict does not catch.

**4. Career-leverage weight set** — done, but **the premise of this item was wrong and is corrected here.**

*"The profile system already supports alternative weights."* It did not. The profile carried preference
points — languages, topics, avoid terms, capped at ±25 — layered over a single module constant that the
scorer read directly in forty-five places. There was no mechanism for a different set, and this one mainly
needs to **remove** a penalty, which preference points can only ever add to.

So Phase 3 built the mechanism: `src/rank/weight_sets.ts`, a named shallow override over `WEIGHTS`, plus
migration 013 to store the selection and `--weights career-leverage` to try one for a single run without
editing settings. The refactor threading weights through the scorer was verified the way this project
verifies refactors — **five CLI commands run old against new over the dev fixture, byte-identical output** —
not by inspection.

What the set changes: the −6 penalty above 60,000 stars becomes **0**, not positive. Removing an obstacle is
defensible; claiming that fame is itself a merit would be inventing a signal. The mid-size bonus halves and
setup cost halves, since setup is paid once and then you stay.

What it deliberately does not touch: **responsiveness and merge rate keep their full weight.** If nobody
reads outside pull requests then a famous project is worth less than an obscure one, not more, and no
career objective survives a pull request nobody merges. A test asserts no set touches those.

**Velocity and bounties are not scored, by either set.** That continues the Phase 2 decision: nothing in
`weights.ts` has been validated against an outcome, and a second set of unvalidated beliefs is already one
more than the evidence supports. Momentum is a filter and a displayed fact, not points.

---

## Phase 4 — Personalisation

Deliberately last: every feature here grows in value with usage history, so building it early gives it
nothing to bite on.

**1. Boost repos where you already have footing.** A second contribution is perhaps five times cheaper
than a first — you know the codebase, maintainers recognise your name, review is faster. Compass
currently ranks it identically to a stranger's repo. Fetch your merged-PR history once
(`is:pr author:you is:merged`) and weight those repos up. **This inverts the strategy from "find a new
issue" to "deepen where you have footing"** — which is also what actually gets you hired or accepted to
GSoC.

**2. Local checkout detection.** `setup_weight: heavy` is irrelevant if the repo is already on your
disk. A configured list of local paths zeroes that cost out. The tool currently re-charges you for a
sunk cost.

**3. Time-available matching, using your own multiplier.** Once the journal knows your ratio (one
recorded pair so far, at 2.3×), "show me what I would actually finish tonight" becomes computable
rather than aspirational. This closes the loop and answers the founding question properly for the
first time.

**4. `watch` and a weekly digest.** You have decided a given org matters; you do not want a ranked
list, you want to be told when something good appears there.

**5. Stretch mode.** The profile rewards what you already know, but part of the point is learning.
Rewarding adjacent-but-unfamiliar stacks is a different objective and roughly one line of weights.

---

## Ongoing — validating the weights

Not a phase. A habit, threaded through everything above.

`weights.ts` says responsiveness is worth +22 and light setup +12. Those numbers are **beliefs written
as arithmetic**. Nobody has checked them against an outcome.

With fifteen recorded issues you can build this table:

```
signal present         merged (9)   stalled/abandoned (6)
─────────────────────────────────────────────────────────
responsiveness +22          7                5      ← barely discriminates
invited label  +16          6                5      ← barely discriminates
light setup    +12          8                1      ← discriminates cleanly
under 3 comments +6         9                2      ← discriminates cleanly
```

If it comes out like that, the two **largest** weights are near-useless and two small ones deserve to
outrank them. That is a plausible and uncomfortable result, and **no amount of reasoning gets you
there** — only the journal does.

The calibration ratio matters separately. One pair so far came in at **2.3× the estimate**. If that
holds, every "five-hour issue" is really eleven hours, and the founding question of the project is
miscalibrated until you know your own multiplier.

**Record as a habit, not as a gate.** Because this is personal rather than public, the only person a
wrong weight misleads is you, so nothing here should block a phase. Ten pairs will accumulate over a
few months of normal use.

---

## Deliberately dropped

Consequences of this being personal rather than a product:

| Dropped | Why |
|---|---|
| Central hosting of the corpus | Local-first is correct at this scale |
| Multi-user, auth, OAuth | One user |
| The congestion problem | You and a few friends will not exhaust cal.com's good-first-issues. This was a serious objection to the platform version and it evaporates |
| Validated weights as a release gate | Only misleads you |
| Large-scale curation | You need ~30 organisations you care about, not 3,000 |
| A "growing market" classifier | "AI agents is hot" is an editorial claim, not a measurement. Tag by hand |
| Hiring-intent prediction | Undetectable from public data. Curate or omit |
| The dashboard | Still. The shortlist and decision capture are what make the tool worth opening |

---

## Known limitations

**`report.ts` has not been split.** `maintainers`, `responders`, `explain` and `setup` still mix
querying with terminal formatting. The same `view` / `data` / `render` split as `rank/`, four times.
Until then they have no API endpoints and no screens. Do it when a screen needs them.

**The job runner is not a queue.** In-process lock; a killed server leaves a `sync_runs` row at
`running` forever. The UI reports those without claiming to know whether they are a live CLI run or a
corpse. Fine for one user.

**Nothing is indexed for ranking.** `shortlist` takes 2–4s on ~86,000 issues, and the 50,000-row fetch
cap is reachable at that size. The `fetch-cap-hit` notice reports it.

**Framework vocabulary is fixed** at 34 entries. A project built on something outside it shows no tag
— absent, not absent-of-tech.

---

## If a scraper ever becomes necessary

It should not, given ROSS ships datasets and GSoC publishes a list. But if it does, one rule matters
more than the rest:

**A scraper returning empty must record "unknown", never "none".** A broken selector silently becomes
"no YC companies exist", and a false finding is worse than a gap. That is this project's `null` ≠ `0`
principle in a new domain, and it is the failure mode that will actually bite.

Also: prefer official exports, cache aggressively, date-stamp everything, and expect permanent
maintenance.

---

## The honest risk

It is not technical. It is that building continues instead of contributing.

There is a working tool and **one** recorded outcome pair. Every hour spent on the org layer is an hour
not spent generating the data that would make the ranking real.
