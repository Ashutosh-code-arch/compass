# Compass — context handoff

**Read this first if you are picking the project up cold.** It is the working document: what exists,
what was decided and why, and what to build next. User-facing documentation lives in `README.md` and
`docs/`, and **`docs/` is the contract** — correct factual errors there, not here.

---

## 1. What it is

A personal tool answering one question: **"should I spend my next five hours on this open-source
issue?"** No LLM anywhere. Every signal is countable.

It measures four things and is careful about which are measurements and which are opinions:

| | What | Trust |
|---|---|---|
| Maintainer attention | 180 days of external PRs: do they reply, how fast, do they merge | **Measured**, corrected through six rounds against a 1,000-repo corpus |
| Setup cost | Compose files, env templates, task runners, CI, read across the whole tree | **Measured** |
| Issue signals | Labels, body length, comments, age, author association | Observed facts, **assumed meaning** |
| Your preferences | Languages, frameworks, avoid terms, star band | **Yours**, not a measurement |

**Scope decision (recent and important): this is for one person and a few friends.** Not a product,
not hosted, not multi-user, not being marketed. That removes several hard problems — see §6.

---

## 2. Current state

**370 tests, 13 migrations, ~17,000 lines TypeScript. All green.**

```bash
npm install && npm run web:install
npm run migrate
npm start                 # builds the frontend, serves app + API on :8787
```

Verification workflow — all three must pass:

```bash
npm test           # ~370 tests, ~3s, no database needed
npm run typecheck  # tsc --noEmit, strict + noUncheckedIndexedAccess
                   #   + exactOptionalPropertyTypes + erasableSyntaxOnly
npm run docs:check # documentation against source

npm start          # then, in another shell:
npm run render:check   # loads the built bundle into jsdom against the live server
```

`render:check` was ad hoc until now and is a script. A frontend that compiles is not a frontend that
works: `tsc` says nothing about whether the app mounts, whether a fetch succeeds, or whether clicking a
tab shows anything. It asserts the app mounts, the organisation table renders with its denominators,
and the drill-down carries its filter.

### Built

Corpus discovery and incremental issue sync · maintainer attention metrics · setup complexity from the
full file tree · framework detection (34 entries) · ranking with itemised breakdowns · decisions
journal and calibration · `add owner/name` · skills profile and reputation gate · JSON API (13
endpoints) · React UI (Shortlist, What you decided, What you want, The corpus) · pagination · language
and stack pickers · sync from the UI with progress · first-run guidance · `prune` · full docs with an
automated checker · **Phase 0: star history, the organisation object model, rejection patterns, and
CLA/DCO detection** · **Phase 1: the organisation layer (`orgs`, `GET /api/orgs`, a fifth screen),
the GSoC importer and year filter, the calendar line, and `shortlist --org` as the drill-down** ·
**Phase 2: claim detection on demand, PR queue depth, quiet age, and bounty labels** ·
**Phase 3: star velocity, the hype filter, ROSS ingestion, and named weight sets**.

### Architecture in one rule

**Anything with judgement in it lives in a module with no database, no network, no clock, and no
console.** That is what `PURE` marks in the source. It is why ~370 tests run in three seconds and why
every decision is reachable from a fixture.

```
rank/view.ts     PURE. Presentation models. May NOT import db.ts
rank/data.ts     Queries -> view models. May NOT format
rank/render.ts   Terminal output. Every value already computed
http/server.ts   JSON. Every value already computed
```

Also pure: `rank/score.ts`, `rank/profile.ts`, `rank/patterns.ts`, `rank/weight_sets.ts`,
`claims/detect.ts`, `velocity/compute.ts`, `org/view.ts`, `org/gsoc.ts`, `org/ross.ts`,
`setup/parse.ts`, `setup/stack.ts`, `setup/agreement.ts`, `metrics/compute.ts`, `params.ts`, the day
bucketing in `sync/stars.ts`, and the path classification in `sync/tree.ts`.

`org/` follows the same shape as `rank/`: `view.ts` holds every combining judgement (modal verdict,
pooled merge rate, distributions, the GSoC calendar), `data.ts` only queries, `render.ts` only formats.

---

## 3. Conventions that are load-bearing

- **`null` means unmeasured. Never zero.** Runs from the SQL through the pure modules to the dash in
  the UI. Reporting absence as zero is the easiest way to make this tool lie.
- **Comments explain why, not what.** `weights.ts` is the model: every number carries the observation
  that produced it.
- **No `process.exit()` on normal paths** — it truncates buffered stdout.
- **Bind parameters need static type guards.** `$3::text is null or ...`, not `$3 is null or ...`.
- **`--limit` must be positive; staleness flags accept zero.** `src/params.ts` encodes this once for
  both CLI and HTTP.
- **Bad input is refused, not coerced.** A silently ignored parameter produces a plausible answer to a
  question nobody asked.
- **Query parameter names mirror CLI flags**, hyphens included, so a failing URL transcribes into a
  command line. Do not "tidy" them to camelCase.
- **Never put backticks inside a SQL template literal.** It terminates the string and the parser error
  points nowhere near the cause. This has bitten once.

---

## 4. Bugs found, and what each taught

Worth reading before changing related code.

**Phase 3 additions (most recent session)**
- **The roadmap was WRONG and is corrected.** It said "the profile system already supports alternative
  weights". It did not: the profile carried preference points capped at ±25 over a single module constant
  the scorer read in forty-five places, and `career-leverage` mainly needs to REMOVE a penalty. The
  mechanism is now `rank/weight_sets.ts` + migration 013. **The threading refactor was verified by diffing
  five CLI commands old-against-new over the dev fixture — byte-identical — not by reading it.**
- **Velocity returns null, never zero.** Fewer than two samples, or a span under `MIN_SPAN_DAYS` (7). A
  zero baseline gives a null multiple rather than an enormous one. `momentum: null` is NOT `steady`.
- **`hype` is never reached from growth alone.** It needs a measured capacity concern too. A verdict that
  amounted to "this project is popular" would be taste dressed as measurement. In testing a repo came out
  `hype` while reading `responsive`, because of 214 open PRs with the oldest at 840 days — which is the
  whole point of the combination.
- **Velocity is aggregated to two endpoints plus a count in SQL, not fetched row by row.** A ninety-day
  window over a thousand repos is tens of thousands of rows to use two per repo. `velocityBetween` is the
  single implementation both callers go through, so the rules cannot drift.
- **`velocity/index.ts` and `types.ts` exist so PURE modules never import `data.ts`.** A pure module
  importing a file that imports `db.ts` compiles fine and quietly breaks what makes the suite fast.
- **A `select *` over a join put the funding value into `kind`** in the ROSS importer, caught only because
  migration 010's CHECK constraint rejected it — the same positional fragility the ROSS parser deliberately
  refuses to make. **Name insert columns explicitly.**
- **Neither weight set scores velocity or bounties.** Still no validated weights; a second set of beliefs
  is already one more than the evidence supports.

**Phase 2 additions**
- **Phase 2 adds five facts and NO weights, on purpose.** A claim verdict exists only for issues you
  have checked, so scoring it would order two identical issues by how you had spent your requests. And
  no weight in `weights.ts` has been validated against an outcome yet — six more unvalidated numbers
  would make the ranking harder to trust, not better. `view.test.ts` asserts current state does not move
  the score. **Do not quietly add weights for these later without recording outcomes first.**
- **`open_prs` already existed and means something else.** Open EXTERNAL pull requests inside the
  sampled window, and the denominator for `open_stale_rate` and the dormancy rule. Queue depth is
  `open_pr_total`. Both columns now carry SQL comments; the names are one letter apart in meaning and
  four in spelling.
- **Queue depth is a separate filtered connection, not a filter over the PR window.** That window is the
  40 most recent PRs, so counting open ones in it would report "40" for a repo with 900.
- **A claim needs a first-person volitional subject.** "is anyone working on this?", "can you take
  this?", "are you still working on this?", "I'll take a look" and "use /assign me to claim issues" are
  all tested non-claims. The last was found by a failing test. "I'd like to work on this if nobody else
  is" IS a claim, deliberately — a false `free` is the expensive direction.
- **No `issue_claims` row means never checked, which is not `free`.** Nothing renders it as free. This is
  the `null` ≠ `0` rule in the place where getting it wrong costs an evening.
- **My own render check was wrong before the app was.** It asserted against the page's concatenated
  `textContent`, where "DCO sign-off" followed by "contested" reads as "sign-offcontested" and defeats a
  `\b` regex. It now asserts against the element. **Prefer `querySelectorAll` over textContent regexes
  in `scripts/render-check.mjs`.**

**Phase 1 additions**
- **`CANDIDATE_GATES` is now shared between the shortlist and the org rollup**, with a test asserting
  both interpolate it. The org table reports open candidates per organisation; a second copy of the
  gates would have meant a row promising six that opens onto four. **The dormant filter deliberately
  stays out of the shared fragment** — the org table's most valuable row is a dormant GSoC organisation
  with forty open issues, and sharing that gate would hide it.
- **Organisation values are combined, never averaged into a score.** Modal verdict with ties broken
  toward the worse; median of per-repository medians; pooled merge rate carrying its denominator; setup
  as a distribution. Ordering is an ordinal cascade so any position is explainable by pointing at a
  column.
- **The GSoC list is not bundled and must not be.** Published names are programme names, not GitHub
  logins, and writing 185 of them from memory would be fabricating dated curated data. The importer
  refuses an empty file and refuses a file that is mostly unparseable, for the same reason `null` is
  never `0`.
- **`gsoc.estimated`** is true for every year after 2026, because only 2026's timeline is published.
- **jsdom cannot execute `<script type="module">`**, which is what Vite emits. `render:check` fetches
  the bundle and evaluates it in the window instead, and asserts the bundle has no top-level
  `import`/`export` so the day that stops being true is a clear failure rather than a blank page.

**Phase 0 additions**
- **The `RUN_KINDS` drift guard was itself broken.** It searched every migration for
  `check (kind in (...))`, assuming only one table had a column called `kind`. Adding `org_tags.kind`
  made it fail and blame the new migration. Now table-scoped via `src/schema_constraints.ts`, and two
  more guards share that reader. **A guard that fires on unrelated changes is a guard that gets
  deleted.**
- **`org_tags` is a tall table, not array columns.** One row per claim, each with its own
  `reviewed_at not null`. A single review date cannot say when *each* value was checked.
- **Star history buckets to the UTC day, and 304s count.** Instants would let sync frequency
  masquerade as sampling quality. An unchanged ETag covers the star count, so a 304 is an observation
  — and recording it is what keeps the quiet end of the corpus from having one ancient sample and no
  computable velocity.
- **Migration 009 backdates a first sample** from `repos.stars` at `meta_synced_at`, never at `now()`.
  Claiming today for a three-week-old figure would fabricate a flat stretch and a velocity of zero,
  which is worse than no velocity.
- **`contributor_agreement` is `none` only when a CONTRIBUTING file was read.** Nothing found and
  nothing read is null. Positive findings survive tree truncation; only absence is withheld.
- **Rejection patterns are shown, never scored.** Judged issues are gated out of the shortlist, so the
  derivation describes the project, not the candidate. Two false positives were designed out and are
  tested: a bare "sign off" is not a DCO, and `declarations.yaml` does not contain a CLA.

**Performance**
- `why` scanned the whole corpus per expansion (~2,600ms at 86k issues) because it rebuilt per-repo
  context from every candidate. Scoping to one repo: **14ms**. `view.test.ts` asserts the invariant —
  **if a future signal reads across repositories, that test fails and the scoping must be reverted.**
- The 50,000-row fetch cap is reachable at ~86k issues. `fetch-cap-hit` reports it. **Do not suppress
  that notice** — the ranking has seen a recency-ordered subset when it fires.

**Correctness**
- `classifySetupWeight` accepted `treeTruncated` and **never read it**. Harmless only while
  `treeTruncated` equalled `filesSeen === 0`. Once the tree walk was real, GitHub truncation on huge
  repos would have yielded a confident `light` from a partial listing. **A parameter accepted and never
  read is a latent bug, not dead code.**
- An unrecognised `--stack` returned the **entire corpus**. The SQL inferred "a stack was requested"
  from resolved arrays being non-empty — indistinguishable from an unknown term. A separate boolean now
  carries intent. **A filter that silently does not filter is worse than one that errors.**
- `heldBackInRepo` depended on page size, so the same repo read "+3 more" at one page size and "+7" at
  another. The walk now covers the whole ranked list.
- Language filter matched case-sensitively; `typescript` returned an empty shortlist that looked like a
  real answer. Now `lower() = lower()`, and the real fix is a picker.
- `GITHUB_TOKEN` was required just to *read* the corpus, so a restored database could not be queried
  and the "no token" screen was unreachable. Now checked only where network calls happen.
- `prune --dormant` would have undone `add`. Manually added repos carry
  `discovered_via = 'manual'` and are protected.

**GitHub API**
- `authorAssociation` reports `MEMBER` only for **public** org membership.
- Prow projects approve by comment and let bots merge — comment liveness is essential or they look dead.
- Bot detection by a `bot` name suffix misclassifies real people (the human login `klembot`). Hence the
  manual `COMPASS_IGNORE_LOGINS` list.
- NUL bytes in issue bodies need a `JSON.stringify` replacer, not a post-serialisation regex.
- `TypeError: terminated` is undici aborting the body stream at `.json()`, not at `fetch()`. Both must
  sit inside the retry guard.

---

## 5. How things are verified

- **SQL is parsed** against the real Postgres grammar in the test suite, so a syntax error fails
  `npm test` rather than `npm run migrate`.
- **GraphQL is validated** against a hand-written stub schema.
- **`RUN_KINDS` is checked against the SQL `CHECK` constraint** — they drifted once and every setup run
  failed on insert.
- **HTTP routes via `app.inject()`**, only paths that fail validation before the data layer. A mocked
  pool would only assert that the mock behaves like the mock.
- **Refactors are verified by diff, not inspection.** Postgres in a scratch dir,
  `fixtures/dev_corpus.sql`, run old and new side by side across many commands, `diff`. The Slice 6
  refactor came out byte-identical, which is what licensed the claim.
- **The UI is verified by rendering it** — the built bundle loaded into jsdom against a live server,
  asserting it mounts, fetches, renders, and that interactions work. A frontend that compiles is not a
  frontend that works.
- **`npm run docs:check`** verifies links, anchors, npm scripts, CLI flags, all endpoints against
  `server.ts`, weight values, the ±25 cap, verdicts, vocabulary size, migration count. It has caught
  four real problems including a flag documented before it existed.

---

## 6. The strategic reframe (most recent conversation)

The original framing was "rank issues in a corpus someone gives me." The real need is different.

**The user does not have a corpus, and the corpus is the product.** Someone wanting to contribute to a
growing, well-regarded organisation — cal.com, YC-funded companies, GSoC orgs — does not know which
organisations exist. `src/seeds/queries.ts` (a few hardcoded searches, 1k–30k stars) is the weakest part
of the system and just became the most important.

**They pick an organisation first, then an issue.** There is no organisation concept today — repos carry
an `owner` string. The object model needs one.

**Compass's real moat:** every competitor (goodfirstissue-style aggregators, up-for-grabs, CodeTriage)
lists issues carrying a label. **None measure whether maintainers merge outsider work.** That is built,
tested, and differentiated.

**The hype filter is the killer combination.** ROSS Index Q1 2026 is topped by repos founded *in 2026*
at 30k–120k stars. A project that went 0→119k in months is one of the worst places to contribute —
thousands of drive-by PRs, no review capacity. **Velocity finds what is hot; the responsiveness engine
is the only thing that says whether hot is contributable.**

**Compass currently fights this user:** a −6 penalty above 60k stars hits exactly the marquee repos, and
seed queries cap at 30k.

### Decisions made

- **GSoC is a tag and a filter, not a tab.** A "coming soon" tab is dead UI for eight months and teaches
  the wrong behaviour — the contributions that matter land *before* the February announcement.
- **Do not scrape YC.** `RunaCapital/ROSS-Index` publishes datasets as a git repo, already joined: org,
  `owner/repo`, stars, growth multiple, founding year, funding including YC. No ToS question, no brittle
  HTML. GSoC publishes its org list annually.
- **Derive velocity yourself** from `sync repos`, which already fetches star counts. Measured, dated,
  yours, and covers repos no index lists.
- **Personal, not a platform.** Drops central hosting, auth, the congestion problem, weight validation
  as a release gate, and large-scale curation.

### GSoC timing facts (verified)

- 2026: 185 orgs announced **Feb 19**; mentor discussion **Feb 19 – Mar 15**; applications **Mar 16–31**;
  coding **May 26 – Aug 23**.
- So the useful window for 2027 is roughly **September 2026 – February 2027**, and the 2026 list is
  public now and highly predictive of next year's.

---

## 7. What to build next

Full detail in **`docs/roadmap.md`**. Summary:

**Phase 0 — DONE.** `repo_stars_history` (migration 009, writing from `sync repos` including 304s,
`seed` and `add`; coverage visible on `status` and the corpus screen) · `organizations` + `org_tags`
(migration 010, backfilled and kept in step by `refreshOrganizations()`) · rejection patterns
(`rank/patterns.ts`, on the shortlist and in the breakdown) · CLA/DCO detection (migration 011,
`setup/agreement.ts`). **The clock is now running — every day before Phase 3 is a day of history.**

**Phase 1 — DONE.** `orgs` CLI · `GET /api/orgs` · the "Who to work with" screen · `shortlist --org`
drill-down · `gsoc import` with `reviewed_at` and required `--source` · the calendar line. Nothing here
needs revisiting before Phase 2.

**Phase 2 — DONE.** Claim detection (`claims`, `POST …/claims`, a button on the expanded row, cached
with `checked_at`) · `--exclude-claimed` · quiet age · exact PR queue depth with the oldest entry ·
bounty labels and comment hints.

**Phase 3 — DONE.** Star velocity from your own history · the hype filter (`--momentum`) on both the
shortlist and the org table · `ross import` · named weight sets with `--weights career-leverage`.

**Phase 4 — personalisation. This is the last planned phase, and every item in it is worth more the more
history exists — which is the argument for doing the recording first.** In rough order of value:

1. **Boost repos where you already have footing.** A second contribution is perhaps five times cheaper
   than a first. Fetch `is:pr author:you is:merged` once and weight those repos up. Inverts the strategy
   from "find a new issue" to "deepen where you have footing", which is also what actually gets you hired
   or accepted to GSoC.
2. **Local checkout detection.** `setup_weight: heavy` is irrelevant if the repo is already on disk. A
   configured list of paths zeroes that cost. The tool currently re-charges you for a sunk cost.
3. **Time-available matching, using your own multiplier.** Needs the journal. One pair so far, at 2.3×.
4. **`watch` and a weekly digest.** You have decided an org matters; you want to be told when something
   good appears there.
5. **Stretch mode.** Rewarding adjacent-but-unfamiliar stacks is roughly one line of weights, and a
   different objective from the profile's.

Still unsplit: `report.ts` — `maintainers`, `responders`, `explain` and `setup` mix querying with
terminal formatting. Two phases have now been built the right way beside it, so the debt is unchanged
and increasingly conspicuous. Org-level rollup view · GSoC org ingestion and
`gsoc_years` filter · the ranking table nobody else can produce (mentors reply? merge rate? setup?) ·
a calendar-aware line, not a tab. Wants to be usable by ~October.

**Phase 2 — current state.** Claim detection on demand (the biggest time sink: a `good first issue`
with 23 comments is usually 20 people asking to be assigned) · unclaimed age · PR queue depth · bounty
detection.

**Phase 3 — momentum and discovery.** Star velocity (history now exists) · ROSS ingestion, ~20 lines ·
the hype filter · career-leverage weight set that drops the >60k penalty.

**Phase 4 — personalisation.** Deliberately last, because each grows in value with usage history.
Boost repos where you already have a merged PR · local checkout detection · time-available matching
using your own multiplier · `watch` and a weekly digest · stretch mode.

**Ongoing — validate the weights.** `weights.ts` numbers are beliefs written as arithmetic. Fifteen
recorded issues would show whether the two largest weights discriminate at all. One pair so far, at
**2.3× the estimate** — if that holds, every "five-hour issue" is really eleven hours and the founding
question is miscalibrated. **A habit, not a gate.**

---

## 8. The honest risk

Not technical. It is that building continues instead of contributing. There is a working tool and
**one** recorded outcome pair. Every hour on the org layer is an hour not spent generating the data
that makes the ranking real.

Four phases in, this has sharpened rather than eased. There is now a tool that can tell you which
organisation to approach, whether anyone will read your pull request, and whether the issue is really
free — and **one** recorded outcome pair, at 2.3×.

Phases 2 and 3 both declined to add weights, precisely because nothing in `weights.ts` has been checked —
and Phase 3 then added a whole second set of unvalidated beliefs anyway, because the roadmap asked for one.
That is the clearest sign yet of where this is heading: **the tool is now sophisticated enough that its
unvalidated parts outnumber its validated ones by a wide margin.**

The cheapest genuinely valuable thing available has not changed and has not been done:

```
npm run compass -- orgs --momentum rising          # pick an organisation
npm run compass -- shortlist --org <login>         # pick an issue
npm run compass -- claims <owner/name#123>         # check it is really free
npm run compass -- decide <owner/name#123> started --hours 5
                                                   # ...do the work...
npm run compass -- decide <owner/name#123> merged --actual-hours 11
```

Fifteen of those produce the discrimination table in §7 of the roadmap. **Phase 4 does not produce a single
row of it, and three of its five items cannot even be built well without it.**
