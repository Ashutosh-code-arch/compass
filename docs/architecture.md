# Architecture

No build step, no framework beyond Fastify and React, no ORM, no queue, no container orchestration.
Node runs the TypeScript directly.

The design decisions worth knowing are about **where judgement is allowed to live**, because that is
what determines whether it can be tested.

---

## Layout

```
src/
  cli.ts              parseArgs dispatch. No process.exit — it truncates buffered stdout
  config.ts           env loading, cached once
  params.ts           PURE string→value coercion, shared by the CLI and the HTTP query parser
  db.ts               one pg Pool, lazily created
  migrate.ts          the migration runner
  schema_constraints.ts  reads CHECK values out of the migrations, for the drift guards

  github/
    rest.ts           REST client: ETags, retries, rate-limit budget
    graphql.ts        GraphQL client: cost accounting, partial-error handling

  seeds/queries.ts    the discovery searches, targeting a 1k–30k star band

  sync/
    run.ts            withSyncRun: the sync_runs row, budget, 3-second progress heartbeat
    seed.ts           discovery
    repos.ts          metadata refresh via conditional GETs
    issues.ts         incremental issue sync with resumable backfill
    map.ts            PURE API response → database row
    metrics.ts        maintainer attention
    metrics_query.ts  PURE GraphQL query building and response mapping
    setup.ts          setup complexity
    setup_query.ts    PURE file parsing → setup facts
    tree.ts           PURE path classification; the whole-tree walk
    stars.ts          star observations, one per repo per UTC day. PURE day bucketing
    orgs.ts           keeps `organizations` in step with the corpus. One statement

  metrics/compute.ts  PURE statistics: medians, censoring, confidence
  setup/parse.ts      PURE file content → structured facts
  setup/agreement.ts  PURE CLA/DCO detection from CONTRIBUTING text and tree paths

  rank/
    weights.ts        EVERY tunable number, with rationale
    profile.ts        PURE preference shape, validation, default resolution
    score.ts          PURE scoring → itemised breakdown
    candidates.ts     the SQL gates
    weight_sets.ts    PURE. Named weight sets over WEIGHTS. Opt-in, never the default
    view.ts           PURE presentation models: per-repo cap, pagination, summaries
    patterns.ts       PURE derivation of per-repo patterns from your own journal
    data.ts           queries → view models. No formatting
    render.ts         terminal output. Every value arrives already computed

  velocity/
    compute.ts        PURE. Star velocity, and growth crossed with review capacity
    data.ts           endpoint aggregation per repository. No judgement
    index.ts          the pure surface, so PURE modules never import data.ts
    types.ts          RepoMomentum, declared apart from the query layer

  claims/
    detect.ts         PURE. Comment thread -> claim verdict. All the phrasing rules live here
    check.ts          on-demand fetch of one thread, and the dated cache
    render.ts         terminal output for a check

  org/
    view.ts           PURE rollup: modal verdict, pooled merge rate, distributions, the GSoC calendar
    gsoc.ts           PURE parsing of a curated organisation list, and its refusals
    ross.ts           PURE parsing of a ROSS Index dataset. Columns by name, never by position
    ross_import.ts    writes ross_quarter and funding tags, with reviewed_at and source
    data.ts           queries -> view models. No formatting
    import.ts         writes gsoc_year tags, with reviewed_at and source
    render.ts         terminal output: the organisation table

  http/
    server.ts         Fastify: query parsing and status-code mapping only
    jobs.ts           background sync runner: one at a time, no cancellation

  report.ts           maintainers / responders / explain / setup reports
  status.ts           corpus counts and budget usage
  prune.ts            pause repositories not worth syncing

web/                  React + Vite. Its own package.json, builds to public/
migrations/           plain SQL, applied in filename order
fixtures/             dev_corpus.sql, the offline corpus
```

---

## The rule that matters

**Anything with judgement in it lives in a module that has no database, no network, no clock, and no
console.**

That is what `PURE` marks above. Those modules take values and return values, so every decision in them
is testable against a fixture in milliseconds, with no setup. It is why the test suite runs in about two
seconds and why nearly 200 tests exist at all.

The impure layers are deliberately dull: fetch rows, hand them to a pure function, print or serialise
what comes back.

### Three layers in `rank/`

The ranking commands used to query Postgres, apply judgement, and format terminal output inside one
function. That made the judgement untestable — the per-repo cap and the journal's accuracy threshold
could only be reached by running the whole command against a live database and reading the text.

```
view.ts     PURE. Presentation models. May not import db.ts
data.ts     Queries. Returns view models. May not format
render.ts   Terminal output. Every value already computed
server.ts   JSON. Every value already computed
```

Three constraints follow, and each has caught something:

**`view.ts` may not import `db.ts`.** The per-repo cap, pagination, the repo/issue split behind `why`,
and the prediction/outcome pairing all live here, tested against fixtures.

**`data.ts` may not format.** An empty candidate set is a returned value carrying a notice, not an early
`console.log` and a bare `return`. That is what made the empty cases reachable from HTTP at all.

**Renderers own their prose.** Notices come out of the view as structured kinds — `no-candidates`,
`none-scoring`, `fetch-cap-hit` — because the CLI's remedy is a flag to retype and the web UI's is a
control to move. The one thing a renderer may never do is show a number the view withheld: see
`MIN_PAIRS_FOR_MEAN`, which keeps the calibration average hidden below three pairs.

> `report.ts` — the `maintainers`, `responders`, `explain` and `setup` reports — has **not** had this
> treatment yet. Same mechanical change, four times. See [Roadmap](roadmap.md).

---

## Why there is no build step

`package.json` sets `engines.node >= 22.18`, and Node runs `.ts` files by stripping types. The
`erasableSyntaxOnly` compiler flag guarantees nothing in the codebase needs a real transform — no enums,
no parameter properties, no namespaces.

Consequences: `tsc` is only ever a typechecker, `npm test` runs the actual source, and there is no `dist/`
to get stale. The frontend does need Vite, which is why it has its own `package.json` — keeping React and
Vite out of the root preserves the no-build-step property where it matters.

---

## Data flow

```
GitHub REST ──► sync/repos, sync/issues ──► repos, issues
GitHub GraphQL ─► sync/metrics ──► metrics/compute (PURE) ──► repo_metrics
                └ sync/setup ────► setup/parse (PURE) ─────► setup_facts

repos + issues + repo_metrics + setup_facts + profile
      │
      ▼
rank/candidates.ts  (SQL gates: open, unassigned, unlocked, unjudged, not dormant)
      │
      ▼
rank/score.ts (PURE)  ──►  itemised breakdown per candidate
      │
      ▼
rank/view.ts (PURE)   ──►  ranked, capped, paginated, summarised
      │
      ├──► rank/render.ts   ──► terminal
      └──► http/server.ts   ──► JSON ──► React
```

The CLI and the web interface consume the identical view models. When the split was introduced, the
pre- and post-refactor CLI were run against the same fixture corpus across nine command variations and
diffed: byte-identical.

---

## The HTTP layer

Fastify, localhost, no auth. Deliberately thin — it parses query strings, maps error shapes onto status
codes, and serialises. Logic appearing there is logic that belongs in the view layer where it can be
tested without a socket.

**Query parameter names mirror the CLI flags**, hyphens included. The CLI is the fastest way to debug
this system, and transcribing a failing URL into a command line without a translation table is worth the
slightly unusual naming.

The server also serves the built frontend from `public/`, so the app and the API share one origin and the
production path needs no CORS. In development Vite proxies `/api` to the same server, which keeps that
true on both paths. An unknown path under `/api/` returns a JSON 404 rather than the app's HTML, so a
mistyped endpoint fails where the mistake is.

### Sync jobs

`http/jobs.ts` runs scans in-process. Three constraints, each visible in the interface:

- **One at a time**, guarded in-process. Scans share one hourly GitHub budget and `repos` would write the
  same rows twice. The lock cannot see a CLI run in another terminal, so `runningElsewhere` reports those
  separately rather than pretending to guard them.
- **No cancellation.** Nothing here can interrupt an HTTP request in flight, and a stop button that does
  not stop things would be a lie.
- **The token is checked before starting**, so a missing one is a 503 with a fix rather than a failed run
  in the history.

> This is **not** a job queue. A killed process leaves a `sync_runs` row at `running` forever. If you
> need real durability, that is the thing to replace.

---

## The frontend

React, Vite, TanStack Query. Four screens in `web/src/`. Every judgement it displays was made
server-side; the client formats and never computes.

Two rules drive the visual system, both derived from the tool's own principles rather than taste:

**Nothing ordinal is drawn as continuous.** Responsiveness and setup weight are buckets, so they render
as discrete stepped cells plus the word itself — never a percentage, gauge, or smooth bar. A bucket drawn
as a percentage claims precision the verdict does not have.

**The evidence outranks the score.** The total sits in the row corner labelled `NO UNITS`. The emphasis a
dashboard would spend on a big number goes to the provenance bar instead — the to-scale split of project
versus issue, which is the most useful thing on the row and is not derivable from the capped evidence
lines.

Credits are indigo and debits ochre rather than green and red. A negative line is a preference function
subtracting points, not a moral failing, and green/red would assert a judgement the data does not
support.

---

## What is deliberately absent

| Not here | Why |
|---|---|
| ORM | Plain SQL. The queries are the interesting part and hiding them helps nobody |
| Redis, BullMQ | One user, cron-driven syncs. A queue is infrastructure with no requirement behind it |
| Docker Compose | Postgres and Node. Adding orchestration to avoid two installs is a poor trade |
| NestJS | Fastify with nine routes needs no framework on top |
| Auth | Single user, localhost. Auth belongs with multi-user, and building it now is scaffolding for a requirement that does not exist |
| An LLM | Every signal here is countable. A model would add cost, latency and non-determinism to arithmetic |

The last one is worth restating: **there is no AI in this tool.** Whether a language model reading issue
bodies would add anything is an open question, and the decisions journal exists partly to answer it.
