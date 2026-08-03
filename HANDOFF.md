# OpenSource Compass — project handoff

Working name: `opensource-compass`. Local directory is `opensource-navigator`.

A personal, single-user tool that answers one question: **"should I spend my next five hours on this
open-source issue?"** CLI, a JSON API, and a React UI. No LLM anywhere.
~12,600 lines of TypeScript, 194 tests.

This document is the full context for continuing development in a fresh conversation.

---

## 1. Current state

Built and working:

| Slice | What it does | Status |
|---|---|---|
| 1 | Repo + issue corpus in Postgres, incremental sync | done |
| 2 | Maintainer responsiveness metrics (GraphQL) | done, 4 calibration rounds |
| 3 | Setup complexity from files at HEAD | done, 2 calibration rounds |
| 4 | Ranked shortlist + evidence panel | done, 3 calibration rounds |
| 5 | Decisions journal (`decide` / `journal`) | done, **zero rows recorded so far** |
| — | `prune` (pause repos not worth syncing) | done |
| 6 | JSON API over Slices 4–5 (`serve`) | done |
| 7 | React UI: shortlist, why, decide, journal | done, verified end to end |
| 8 | Skills profile (§9a) + reputation gate (§9c) | done, verified end to end |
| 9 | Pagination, language picker, sync-from-UI | done, verified end to end |

Live data as of handoff:

- **1,076 repos** (1,072 active, 4 paused)
- **~86,700 issues**
- **repo_metrics for 1,072 repos** (~500 responsive, ~190 dormant, ~160 slow, ~150 unknown, ~60 moderate)
- **setup_facts for only 50 repos** ← see §8, this biases the ranking badly
- **decisions: 0 rows** ← the thing that would make any weight defensible
- ~14 large repos still resuming their issue backfill page by page

## 1a. Where the documentation lives

This file is the working document for resuming mid-project. User-facing documentation now lives
separately, and **it is the place to correct a factual error** — this file is notes, `docs/` is the
contract:

- `README.md` — installation and first run, written for someone new to the project
- `docs/getting-started.md` — full walkthrough
- `docs/how-ranking-works.md` — every signal and weight, measured versus assumed
- `docs/cli-reference.md`, `docs/api-reference.md`, `docs/configuration.md`, `docs/database.md`
- `docs/architecture.md`, `docs/development.md` — the layering rules and conventions
- `docs/roadmap.md` — supersedes §9 below for anyone who is not resuming a session
- `docs/design-notes.md` — the original README, kept for its rationale

The docs are checked against the source, not just proofread: internal links and anchors, every npm
script and CLI flag, every documented endpoint against `server.ts`, the verdict list against `view.ts`,
twenty weight values against `weights.ts`, and the ±25 preference cap against `profile.ts`. **Re-run
that check after changing a weight, a flag, or an endpoint.** Writing a doc that quietly stops being
true is worse than having no doc.

## 2. Running it

Requires **Node ≥ 22.18** (runs TypeScript natively, no build step) and Postgres 16.

```bash
cp .env.example .env      # DATABASE_URL, GITHUB_TOKEN (read-only public repo access, no scopes)
npm install
npm run compass -- migrate
npm test                  # 166 tests
npm run typecheck
```

Commands:

```
migrate
seed [--dry-run] [--only id,id] [--max-pages N]
sync repos|issues|metrics|setup|all   [--limit N] [--repo owner/name] [--stale-days N] ...
status
maintainers [--sort median|ignored|stale|reviewed|merge] [--min-prs N] [--bucket X]
explain owner/name                    per-PR evidence behind one repo's metrics
responders [--repo owner/name]        who answers external PRs; exposes bot first-responders
setup [--sort weight|services|env|runtime] [--weight X] [--max-services N]
shortlist [--limit 20] [--min-score 20] [--per-repo 2] [--language X] [--labelled]
          [--max-setup light|moderate] [--min-stars N] [--max-stars N] [--include-dormant]
why owner/name#123                    itemised score breakdown
decide owner/name#123 <verdict> [--hours N] [--actual-hours N] [--reason "..."]
journal [--limit N]
prune [--dormant] [--heavy] [--min-confidence medium|high] [--apply] [--unpause]
serve [--port 8787] [--host 127.0.0.1]
```

`serve` starts a Fastify JSON API on localhost. Query parameters are named after the CLI flags so a
failing URL transcribes into a command line without a translation table.

```
GET  /api/shortlist?limit=20&min-score=20&per-repo=2&language=X&labelled&max-setup=moderate
                   &min-stars=N&max-stars=N&include-dormant&fetch-limit=N
GET  /api/issues/:owner/:name/:number/why
GET  /api/journal?limit=30
POST /api/decisions   {"ref":"owner/name#123","verdict":"started","predictedHours":4}
GET  /api/verdicts    /api/health
```

No auth, bound to 127.0.0.1. `POST /api/decisions` writes; do not bind 0.0.0.0 without adding auth
first. `COMPASS_HOST` / `COMPASS_PORT` override.

`npm run compass:tsx` and `npm run test:tsx` exist as fallbacks for older Node.

## 3. Architecture

```
migrations/           001..007, plain SQL, applied by a tiny runner
fixtures/             dev_corpus.sql — offline corpus for the diff-verification recipe
web/                  React + Vite frontend; its own package.json, builds to public/
  src/api.ts          typed client; query-param names mirror the CLI flags
  src/components.tsx  stepped meters, provenance bar, evidence chips, ledger
  src/Shortlist.tsx   filter rail, ranked rows, inline `why` breakdown
  src/Journal.tsx     decision trail and the calibration figure
  src/DecideDialog.tsx  lifecycle-aware capture: predictions on open, outcomes on close
public/               Vite build output, gitignored; Fastify serves it when present
src/
  cli.ts              parseArgs dispatch; no process.exit (it truncates stdout)
  params.ts           PURE string->value coercion, shared by the CLI and the HTTP query parser
  config.ts           env loading; COMPASS_IGNORE_LOGINS
  db.ts               pg pool, bulkUpsert, jsonb(), stripNul()
  migrate.ts
  status.ts           corpus counts, coverage, run history, invariant checks
  prune.ts
  report.ts           maintainers / explain / responders / setup reports
  github/
    rest.ts           REST client: ETag, pagination, per-resource rate budget, retries
    graphql.ts        GraphQL client: batched aliases, partial-error handling, real cost accounting
    types.ts
  metrics/
    compute.ts        PURE responsiveness statistics + bot/insider classification
  setup/
    parse.ts          PURE file parsers (compose, runtimes, env, CI) + weight classifier
  seeds/queries.ts    the corpus definition — edit this file
  sync/
    map.ts            payload -> row mappers
    run.ts            sync_runs bookkeeping, RUN_KINDS
    seed.ts repos.ts issues.ts metrics.ts metrics_query.ts setup.ts setup_query.ts
  rank/
    weights.ts        EVERY ranking tunable, with rationale — still the DEFAULTS under a profile
    profile.ts        PURE: profile shape, validation, and default resolution
    score.ts          PURE scoring -> itemised breakdown
    candidates.ts     candidate SQL (hard gates)
    view.ts           PURE presentation models: per-repo cap, summaries, journal pairing
    data.ts           queries -> view models; no formatting
    render.ts         terminal output; every value arrives already computed
  http/
    server.ts         Fastify; query parsing and status-code mapping only
    jobs.ts           background sync runner: one at a time, no cancellation, token checked first
```

**The layering rule, and why it is worth enforcing.** `rank/report.ts` used to query Postgres, apply
judgement, and format terminal output in one function. The judgement was therefore untestable: the
per-repo cap and the journal's accuracy threshold could only be reached by running the command
against a live database and reading the text. The split is:

- **`view.ts` may not import `db.ts`.** Anything with judgement in it lives here, under test against
  fixtures. Same rule as `metrics/compute.ts` and `setup/parse.ts`.
- **`data.ts` may not format.** An empty candidate set is a returned value carrying a notice, not an
  early `console.log` and a bare `return`. That is what made the empty cases reachable from HTTP.
- **Renderers own their prose.** Notices are structured kinds (`no-candidates`, `none-scoring`,
  `fetch-cap-hit`), because the CLI's remedy is a flag to retype and the UI's is a control to move.
  A renderer may never decide to show a number the view withheld — see `MIN_PAIRS_FOR_MEAN`.

`report.ts` (maintainers / responders / explain / setup) has **not** had this treatment yet. It is
the same mechanical change repeated four times.

Deliberate stack decisions, all documented in the README:

- **`pg` + plain SQL migrations, not Prisma.** The sync does multi-row `ON CONFLICT` upserts. When
  the UI needs an ORM, `prisma db pull` introspects cleanly.
- **No Redis, BullMQ, NestJS, Docker Compose.** A cron entry provides everything needed.
- **REST for issues, GraphQL for metrics and setup.** REST because `since=` gives incrementality;
  GraphQL because per-PR review data over REST would need ~40,000 requests against a 5,000/hr limit.
- **Pure modules for anything with judgement in it** (`metrics/compute.ts`, `setup/parse.ts`,
  `rank/score.ts`) so it is testable without network or database.

## 4. Schema

- `repos` — corpus, sync watermarks (`issues_synced_at`, `issues_backfill_page`, `meta_etag`),
  `sync_state` in (active, paused, gone), verbatim payload in `raw` jsonb
- `issues` — issues only (PRs filtered out), `raw` jsonb
- `repo_metrics` — one row per repo, Slice 2 output, per-PR audit trail in `detail`
- `setup_facts` — one row per repo, Slice 3 output
- `decisions` — the journal: verdict, predicted_hours, actual_hours, reason
- `sync_runs` — every run, with rate-limit snapshot and error

Every repo/issue row keeps the raw API payload. You will change your mind about which fields matter;
re-fetching is expensive and reshaping from `raw` is free.

## 5. Design principles that have governed every decision

These are the non-negotiables. They were arrived at by hitting real problems, and abandoning them is
how this becomes a system that looks authoritative and lies.

1. **No fabricated precision.** The original spec wanted "Overall Confidence: 86%" and "Estimated
   setup: 35 minutes". Neither is measurable. Verdicts are **ordinal** (`dormant | slow | moderate |
   responsive`, `light | moderate | heavy`), sample size is reported as a confidence bucket, and the
   ranking score explicitly "has no units and predicts nothing".
2. **The evidence panel is the product, not the score.** Every ranking line carries the raw value
   that produced it. A rank you cannot interrogate is a rank you cannot correct.
3. **`null` never means `0`.** An unmeasured compose service count is `—`, not zero. Reporting
   absence as a finding makes unreadable repos look simple.
4. **Hard gates eliminate, weights rank.** An assigned issue is not a weak candidate, it is somebody
   else's work — excluded in SQL, not penalised in the score.
5. **Prefer under-flagging to over-flagging when the costs are asymmetric.** A missed bot inflates
   one median; a human misclassified as a bot makes an active project look dead.
6. **Every expensive operation is resumable and budget-aware.** Watermarks only advance on success;
   runs abort cleanly at a reserve floor rather than dying mid-repo.
7. **Per-item error isolation.** One bad repo must never discard a 1,000-repo run.

## 6. Calibration history — do not re-learn these

Every one of these came from running against live data, not from reasoning. They are encoded in tests.

**Slice 2, maintainer responsiveness:**

- `median_hours_to_response` is **right-censored**: computed only over PRs that got a reply. A dead
  repo where 2 of 40 got fast replies has an excellent median. Dormancy is therefore checked *before*
  speed, and `no_response_rate` is printed beside the median everywhere.
- **A merge is attention.** Repos that squash-merge without commenting scored 100% ignored alongside
  100% merge rate. `mergedBy` is fetched so an automated merge queue doesn't count as a human.
- **A PR opened this week is not evidence of neglect.** `grace_days` (7) excludes young unanswered
  PRs from the ignore-rate denominator (`decidable_prs`).
- **`authorAssociation` is not a maintainer test.** It only reports `MEMBER` for *public* org
  membership. Whole organisations (EleutherAI, Uniswap, jupyter, ossf) read as 0 responses on 40 PRs.
  Fixed with a per-repo **maintainer roster** from `assignableUsers` + anyone who merged + anyone the
  API did label an insider.
- **Comments are a sign of life.** Prow projects (Kubernetes) approve via `/lgtm` comments and let a
  bot merge; a review-only liveness signal marked them all dormant at a 0% ignore rate.
- **Bot detection is a minefield.** `/bot$/` matched the humans `klembot`, `abbot`, `talbot`,
  `elliotbot`. Suffix matching now requires a separator; known automation is named explicitly; the
  `responders` report finds the rest empirically via `COMPASS_IGNORE_LOGINS`.
- **The roster promotes service accounts.** `mattermost-build` has write access, so it became a
  "maintainer" answering in 0h. `-build`, `-deploy`, `-release`, `-runner`, `-jenkins` added.
- **A tiny open-PR denominator can force false dormancy.** Stale-backlog dormancy now needs ≥5 open
  PRs.
- **A median over 1–2 responses is not a measurement.** `respondedPrs < 3` returns `unknown`.
- **A merge counts as attention whoever pressed the button.** An earlier version ignored merges
  performed by automation. That broke every Prow-based project — Kubernetes approves via `/lgtm`
  comments and lets `k8s-ci-robot` merge — so kueue reported 19 of 21 external PRs "too recent to
  judge" while 11 had already merged. The guard was redundant: bot-*authored* PRs are excluded
  upstream, so anything reaching that check is an outside human's work. Queue merges are labelled
  `MERGED_BY_QUEUE` in the audit trail.
- **`comments(first: 5)` is thin for Prow-heavy repos**, where CI bots fill the early comments and the
  human `/lgtm` lands later. Not yet addressed; the merge fix above covers the dominant symptom.
- **Merge rate is NOT in the responsiveness bucket, on purpose.** Jenkins answers every outside PR
  within 2h and closes 10 of 16 unmerged. That is legitimately `responsive` (someone is home) and a
  bad place to spend five hours. The two facts stay separate; merge rate is weighted in Slice 4.

**Slice 3, setup complexity:**

- Unresolved Maven/Gradle placeholders (`${java.version}`) were reported as versions.
- `.tool-versions` lists linters and test harnesses, not just runtimes — filtered to a runtime allowlist.
- `confluentinc/cp-zookeeper` didn't match `zookeeper` because the pattern anchored on `/`. Images are
  now normalised to the final path segment without tag/digest, then keyword-matched.
- Unparseable workflow YAML must yield `null` for "CI on PRs", not `false`.

**Slice 4, ranking:**

- `fetchLimit` silently capped candidates at 4,000, ranking whichever slice was most recently updated.
- **One repo took 12 of the top 20**, all identically scored. `--per-repo` (default 2) caps it.
- **An epic ranked second**: "Master FR: Pen, Stylus, Handwriting…" with a `good first issue` label.
  `SCOPE_PATTERNS` reads titles for FR/RFC/epic/umbrella/rewrite/decision markers; bodies over 5,000
  chars read as specifications.
- **Every row showed the same three signals** because repo weights dominate. Each score line now
  records `about: 'repo' | 'issue'`; the compact view shows issue lines only.
- **Issue mills.** A small app with issue numbers in the 26,000s, titles like `[Good First Issue] Add
  new Video Game Quote 50`, a dozen opened the same day. Every per-issue signal read as excellent —
  the pattern only exists *across* issues. `buildRepoContext` derives per-repo facts from the
  candidate set in memory; ≥8 invited issues within 7 days costs 35 points.

**Found while adding the UI controls (Slice 9):**

- **`GITHUB_TOKEN` was required to read the corpus.** `loadConfig()` demanded it, so a database
  restored onto a machine without a token could not even run `migrate` or `shortlist` — and the new
  "no token configured" screen was unreachable, because the server died before it could render it.
  The token is now checked by `requireGitHubToken()` in the REST and GraphQL clients, where the
  network calls actually are. **Reading the corpus needs Postgres and nothing else.**
- **The language filter matched case-sensitively.** Typing `typescript` returned an empty shortlist
  that looked like a real answer. Matching is now `lower() = lower()`, but the actual fix is
  `/api/languages` and a picker: you cannot mistype a list.
- **`heldBackInRepo` depended on the page size.** It counted only what had been walked before the
  limit was reached, so the same repository read "+3 more" on one page size and "+7 more" on
  another. The walk now covers the whole ranked list and the page is a slice of the result.
- **A 202 with no immediate feedback invites a double-click.** Waiting for the next poll left up to
  two seconds in which starting a sync visibly did nothing, which is long enough to press again and
  collect a 409. The 202's own body now seeds the running state.

**Found by measuring at corpus scale (Slice 7):**

- **`why` scanned the whole corpus per expansion.** `loadOne` fetched every candidate to rebuild the
  repository context, which is per-repo — so expanding one row cost as much as the entire ranking.
  At 86k issues that was ~2.6s per click. Scoping the query to one repository took it to ~14ms, and
  `view.test.ts` now asserts the invariant that makes it sound: a repo's context is derived from its
  own issues alone. **If a future signal reads across repositories, that test fails and the scoped
  query has to go back.**
- **The 50,000-row fetch cap is reachable on a corpus this size.** A synthetic 86k-issue corpus hit
  it and the `fetch-cap-hit` notice fired, meaning the ranking saw a recency-ordered subset. The
  notice works; the cap may still need raising, and `shortlist` takes 2–4s at that scale regardless.
  Nothing here is indexed for ranking yet — that is the obvious next performance move if it grates.

**Found by the data/render split (Slice 6):**

- `assembleShortlist` never threaded `now` into `rankCandidates`, so issue age and the issue-mill
  window scored against wall-clock time. Harmless in production, and invisible precisely because no
  fixture could be scored reproducibly without it. The clock is now injected everywhere.
- A predicted `0` hours gave `Infinity` and rendered as "Infinityx your prediction". `hoursRatio`
  returns null and the pair reads as incomplete.
- Fastify types the `setErrorHandler` first argument as `unknown` under these compiler flags; narrow
  it before reading `.message`.
- A long-running command breaks the `main().then(() => closeDb())` pattern — the pool would close
  under the listening socket. `main()` returns `'listening'` for `serve` and the teardown skips it.

**Infrastructure bugs worth remembering:**

- `process.exit()` truncates buffered stdout. Never use it; set `process.exitCode`.
- `TypeError: terminated` is undici aborting the **response body stream** — it throws at
  `.json()`/`.text()`, not at `fetch()`. Both must be inside the retry guard.
- Postgres rejects NUL in `text` **and** rejects the `\u0000` escape in `jsonb`. Strip it in a
  `JSON.stringify` **replacer**, never with a regex over serialised output — a body containing the
  literal characters `\u0000` becomes invalid JSON.
- Untyped bind parameters in operator expressions fail: `case when $3 >= $4` gave "inconsistent types
  deduced for parameter $3". `src/sql_params.test.ts` statically scans for this class.
- `RUN_KINDS` in TypeScript and the `sync_runs.kind` CHECK constraint drifted; `src/sync/run.test.ts`
  now asserts they agree.
- Import specifiers need explicit `./` and `.ts`. A bare `src/cli.ts` is a *package* specifier in ESM.

## 7. Verification workflow

Used throughout; worth keeping:

- `npm test` — 194 tests, mostly over the pure modules
- `npm run typecheck` — strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` +
  `erasableSyntaxOnly` (the last guarantees Node can run the TS without transformation)
- **SQL is validated without a database** using Python `pglast` (libpg_query, the real Postgres
  parser): `pip install pglast --break-system-packages`, then `pglast.parse_sql(sql)`. Also used to
  cross-check that code column lists match the migration DDL.
- **GraphQL queries are validated** against a hand-written stub schema with the `graphql` package, so
  a misspelled field fails in `npm test` rather than mid-run.
- **HTTP routes are tested through `app.inject()`**, no socket. Only the paths that fail validation
  before the data layer, plus the constant routes — a mocked pool would only assert that the mock
  behaves like the mock.
- **The UI is verified by rendering it, not by reading it.** The built bundle is loaded into jsdom
  against a live server and asserted on: that it mounts, fetches, and renders rows; that every row
  has a provenance bar with to-scale segments; that meters render discrete cells; that a row expands
  into two ledgers whose subtotals sum to the total; that changing a filter refetches; that
  recording a decision removes the issue from the shortlist and makes it appear in the journal with
  its trail and hours; and that the calibration mean stays hidden at two complete pairs and appears
  at three. Scripts are throwaway, but the shape is worth repeating — a frontend that compiles is not
  a frontend that works, and every one of those assertions failed at least once while being written.
- **Refactors are verified by diff against a fixture corpus, not by inspection.** Postgres 16 in a
  scratch directory, `migrate`, ~18 fixture issues chosen to hit the interesting cases (a repo with a
  deep labelled backlog for the per-repo cap, an assigned issue, a locked issue, a dormant repo, an
  epic with a 6,000-character body), then the old and new implementations run side by side over nine
  command variations and `diff`ed. This caught nothing on the Slice 6 refactor, which is the point:
  it is what licensed the claim that behaviour was preserved. The corpus is committed at
  `fixtures/dev_corpus.sql` with a note on each row's purpose; reload it with `drop database` rather
  than truncating, since `decisions` rows accumulate and change what the shortlist gates out.

## 8. Known limitations and immediate to-dos

**Resolved during the final test pass** (kept for context):

- `setup_facts` now covers all 1,072 repos (802 light, 224 moderate, 46 heavy). Before this, only 50
  had facts and those 50 carried a ~30-point head start in the ranking.
- `prune --apply` has run: 193 dormant medium/high repos paused, leaving 879 active. A further 7
  became dormant in the metrics run afterwards and could be pruned again.

**Still open:**

1. **decisions has 3 issues recorded, 1 with both a prediction and an outcome** (dulwich#1822 at 2.3x
   the estimate). Three complete pairs is where the accuracy figure starts meaning anything, and
   fifteen is where the weights become defensible.
2. **Paused repos keep frozen metrics.** They are excluded from recomputation, so a stored value
   reflects whatever the code did when it last ran. `status` now scopes its invariant check to active
   repos for this reason. If a paused repo is ever unpaused, recompute it with
   `sync metrics --repo owner/name`.
3. `metadata stale >24h` reached 1,076 — `sync repos` defaults to `--limit 1000`, so it cannot cover
   the corpus in one pass.

**Structural limitations:**

- **Slice 3 reads root-level files only.** A compose file under `docker/` or `server/` reads as
  absent, so `mattermost/mattermost` comes out `light`. Read `light` on a large multi-component
  project as "not measured". Fixing it needs `git/trees?recursive=1` per repo (~20% of hourly core
  budget) plus a second pass to fetch what's found. **This is the highest-value remaining backend
  work.**
- **The ranking can't read issues.** Rows 15–20 differ by a label word and a comment count, which are
  proxies for issue quality, not measurements. Distinguishing two plausible tasks needs someone to
  read them. This is the one place an LLM would genuinely earn its place: one call per top-20
  candidate returning a scope estimate and likely files, cached in a column. Effort *estimation*
  still isn't worth it.
- **The 40-PR metrics window is small for busy repos.** Mattermost had 37 insider PRs in its 40 most
  recent, leaving 3 external — hence `confidence: low`. Correct, but thin.
- **The journal aggregates per issue, not per row.** Verdicts arrive over time (`started --hours 4`,
  then `merged --actual-hours 9`), so a per-row view could never pair a prediction with its outcome.
- **The 7-day grace period excludes most PRs on very active repos.** kueue showed 14 of 22 external
  PRs as "too recent to judge". Correct behaviour, but it means the busiest projects are judged on a
  small decided subset.
- **A 200 response with an empty body** was treated as a permanent failure ("unparseable JSON
  (0 bytes)") and killed a batch. Now retried like any other transient condition.
- **The shortlist can return a monolingual list.** With `--min-stars 1000`, all 15 rows came back
  Python — the smaller TypeScript repos were filtered out. Use `--language` if a specific stack is
  wanted.
- **The tool cannot detect an obsolete-but-open issue.** `lightly#1945` ("Raise minimum supported
  Python version to 3.8") ranked 11th while a sibling issue in the same repo referred to that bump as
  already done. This is the clearest argument for the LLM read-the-issue step.
- `--min-score 20` filters ~5% of candidates. Effectively useless; the range is 20–111, median ~59.

## 9. Next implementation: the UI

Requested: enter desired skills → see best repos and issues for those skills → pick one → get clear
local setup instructions → mark completed/merged. Plus a dashboard, and a reputation floor
(stars ≥ 500–1,000).

**Done:** the API-ification refactor, the JSON API, and the shortlist / why / decide / journal
screens (§9 items 3 and 5, plus the whole suggested stack bar the profile). `npm start` builds the
frontend and serves it alongside the API on one origin.

**Still to build.** These are the genuinely new pieces rather than more rendering:

**(a) A skills profile.** ~~Currently `LANGUAGE_POINTS` is a hardcoded map.~~ **Done.** Migration
007 adds a single-row `profile` table; `src/rank/profile.ts` holds the pure shape, validation and
default resolution; `scoreCandidate` takes a `ResolvedProfile` as a fourth argument. Three rules are
load-bearing and each has a test:

- **An empty profile scores identically to the pre-profile tool.** `weights.ts` remains the default,
  which is what let this ship without re-tuning anything.
- **Languages replace wholesale, they do not merge.** Deleting TypeScript in the settings screen has
  to mean it stops scoring, not that it quietly reverts to 14.
- **Preferences are capped at ±25** (`MAX_PREFERENCE_POINTS`). The largest measured weight is 22
  (responsiveness); a preference that outranks every measurement turns the ranking into a filter, and
  the shortlist already has real filters. The API returns 400 with that reasoning in the message.

Topics match `repos.topics` (GIN-indexed since 001) and pay **once, at the best rate** — otherwise a
repo tagged react + frontend + typescript collects three payments for one fact about itself.
`profile.min_stars` / `max_stars` / `max_setup_weight` supply shortlist defaults that an explicit
request still overrides, so a thin shortlist can be widened for one look without editing what is
saved.

**(b) A setup-instructions generator.** `setup_facts` already holds the raw material — runtimes and
versions, compose service count and names, backing services, env var count and template path, task
runner, devcontainer, CI-on-PR. Turning that into an ordered checklist ("install Node ≥22 and Docker;
`cp .env.example .env` and fill 14 variables; `docker compose up` starts 7 services including
Postgres and Kafka; `make test`") is deterministic template work. **Do not let it emit invented
minute estimates** — that's the false-precision failure the whole project has been avoiding. Note
that this depends on fixing the root-only limitation first, or the instructions will be wrong for
exactly the complex projects where they matter most.

**(c) Reputation gate.** ~~Promote `--min-stars` to a profile setting.~~ **Done** — it is in the
profile and surfaced on the settings screen, with the rationale in the copy: below ~500 stars
abandonment risk dominates, above ~50k the labelled beginner issues are claimed within hours. **No
default is set**, deliberately: picking 500 for you would be a preference asserted as a measurement,
and `seeds/queries.ts` already biases the corpus toward the 1k–30k band.

**(e) Sync from the UI.** **Done.** `POST /api/sync/:kind` starts one of the five scans and returns
202; `GET /api/sync` reports the active job, the corpus counts, and recent runs. Three constraints
are deliberate and each is visible in the interface:

- **One at a time**, guarded in-process. Syncs share one hourly GitHub budget and `repos` would write
  the same rows twice. The lock cannot see a CLI run in another terminal, so `runningElsewhere`
  reports those separately rather than pretending to guard them.
- **No cancellation.** A stop button that cannot interrupt an in-flight request would be a lie. The
  screen says so. Budget exhaustion still stops a run cleanly and watermarks make it resumable.
- **The token is checked before starting**, so a missing one is a 503 with a fix rather than a failed
  run in the history.

`withSyncRun` now flushes its counters every three seconds, so a run in progress is observable from
outside the process — useful from a second terminal during a CLI run too. It is **not** a substitute
for a real job queue: a killed process still leaves a row at `running` forever, which is why the UI
reports those rows without claiming to know what they mean.

**(d) A workflow view.** ~~The `decisions` verdicts already model the lifecycle.~~ **Partly done.**
The journal screen renders the trail per issue, and `DecideDialog` captures predictions on opening
verdicts and outcomes on closing ones — the part that actually populates calibration. What does not
exist is the Kanban-ish *board*: columns by `latestVerdict`, drag to advance. Worth doing only if you
find yourself tracking several issues at once; with one or two in flight the list is better.

**Suggested stack** — deliberately lighter than the original spec's NestJS + Redis + BullMQ:

- ~~One small HTTP server in this same project~~ **done**: Fastify, `src/http/server.ts`, `serve`.
  The four ranking endpoints exist. The four in `report.ts` do not yet.
- React + TypeScript + Vite, TanStack Query. MUI is fine if wanted. Nothing frontend exists yet —
  no `web/` directory, no Vite config, no proxy. That is the next thing to create.
- No auth for now — single user, localhost. GitHub OAuth belongs in the multi-user phase.
- Keep the CLI. It is the fastest way to debug, and the sync jobs should stay cron-driven. Keeping
  the HTTP query parameters named after the CLI flags is what makes that debugging path cheap;
  do not "tidy" them into camelCase.

**The remaining half of that refactor:** `report.ts` still mixes querying with terminal formatting
for `maintainers`, `responders`, `explain` and `setup`. Repeat the `view.ts` / `data.ts` /
`render.ts` split four times and those endpoints become trivial. Do it when a screen needs them —
the dashboard does, and the dashboard is explicitly not first.

**Ordering suggestion, revised:**

1. `sync repos` in two passes (see §8.3), then `sync setup --limit 1200`, then `prune`, so the
   ranking is fair. **This is data work on your machine and nothing else should happen first** —
   every screen built before it will be built against a biased ranking.
2. ~~API-ification refactor~~ **done** for the ranking slice.
3. The shortlist + `why` screens against the existing endpoints. `GET /api/shortlist` already
   returns `summary`, `rows` (with `evidence`, `context`, `heldBackInRepo`) and `notices`; render
   the notices, or the empty and fetch-capped states will silently look like "no results".
4. The profile (§9a), which is the first thing needing a migration (007) and a change to
   `scoreCandidate`'s inputs.
5. The workflow board (§9d) over `decisions`. This is what populates the calibration data, so it
   outranks the setup checklist despite being less visibly useful.
6. The setup checklist (§9b), *after* the root-only fix in §8, or it will be wrong for exactly the
   complex projects where it matters.

Resist building the dashboard first — the shortlist and the decision capture are what make the tool
worth opening, and the dashboard is the only screen that needs the `report.ts` half of the refactor.

## 10. Honest state of the thing

The parts backed by real data are Slices 2 and 3: they measure whether maintainers review outside
work and what it costs to get a project running. Those went through six rounds of correction against a
1,000-repo corpus and the tests encode what was learned.

Slice 4's weights have had **zero** validation against outcomes. They are a preference function
written from reasoning, not a model fitted to anything. The score's job is to order candidates, and
`why` exists so you can disagree with any line.

Slice 6 added no measurement at all. It moved code so the judgement in it could be tested and served,
and it verified that it moved nothing else — the shortlist you get today is the shortlist you got
before, to the byte. Do not mistake 166 tests for 166 tests' worth of validated weights; most of the
new ones assert that the assembly does what it says, not that what it says is right.

The single highest-value action is still not code: it is working three issues from the shortlist and
recording `decide ... --hours N` then `decide ... --actual-hours M`. Fifteen of those rows is what
turns `weights.ts` from assertion into measurement, and it is also the only thing that will say
whether an LLM reading issue bodies is worth the complexity. The workflow board in §9d exists to
make that capture a click instead of a command, which is the only reason it ranks above the setup
checklist.
