# Design notes

> This was the original README: the reasoning behind the measurements, the corrections the corpus
> forced, and what has and has not been validated. It is kept because the rationale is the valuable
> part — anyone changing a weight or a metric should read the relevant section first.
>
> For installing and using the tool, start at the [README](../README.md) and
> [Getting started](getting-started.md).

A repository and issue corpus in Postgres, plus maintainer-responsiveness metrics, with incremental
sync that stays well inside GitHub's rate limits. No web server, no queue, no LLM. One process, one
database, one cron entry.

- **Slice 1** keeps a few hundred candidate repositories and their open issues current, cheaply and
  resumably.
- **Slice 2** answers the question that eliminates most candidates before you spend an hour on them:
  *does anyone actually review outside contributions here?*

## Running the app

```bash
cp .env.example .env      # DATABASE_URL, GITHUB_TOKEN
npm install
npm run web:install       # frontend dependencies live in web/
npm run compass -- migrate

npm start                 # builds the frontend, then serves app + API on :8787
```

Open <http://127.0.0.1:8787>. Two screens: the ranked **Shortlist**, and **What you decided**, which
is the journal and the one place a measured number appears.

While working on the frontend, run the two halves separately so you get hot reload:

```bash
npm run serve             # API on :8787
npm run web:dev           # app on :5173, proxying /api to :8787
```

The CLI is unchanged and remains the fastest way to debug anything the UI shows.

## Setup

Requires **Node ≥ 22.18**, which runs TypeScript directly by stripping types — there is no build
step and no transform dependency in the run path.

```bash
createdb compass                 # or: docker run -p 5432:5432 -e POSTGRES_PASSWORD=compass postgres:16
cp .env.example .env             # fill in DATABASE_URL and GITHUB_TOKEN
npm install
npm run compass -- migrate
npm test
```

The token wants read-only access to public repositories and nothing else. A fine-grained PAT with
no account permissions is enough; the corpus never writes to GitHub.

On Node 22.6–22.17, add the flag: `node --experimental-strip-types --env-file-if-exists=.env
./src/cli.ts`. On anything older, `npm run compass:tsx -- <command>` and `npm run test:tsx` use tsx
instead. `erasableSyntaxOnly` is enabled in `tsconfig.json` so `npm run typecheck` fails on any
syntax Node cannot strip — parameter properties, enums, namespaces, decorators. That keeps the
no-build-step path working permanently rather than by luck.

Note that every import specifier carries an explicit `./` and an explicit `.ts` extension. Both are
required: a bare `src/cli.ts` is a *package* specifier in ESM, not a relative path, and newer Node
resolves it as one.

## Commands

```bash
npm run compass -- seed --dry-run          # print resolved queries without touching the API
npm run compass -- seed                    # discover repos
npm run compass -- sync repos              # refresh metadata (conditional GETs)
npm run compass -- sync issues             # backfill, then incremental
npm run compass -- sync metrics            # maintainer responsiveness (GraphQL)
npm run compass -- sync all                # all three, in order
npm run compass -- maintainers             # the table Slice 2 exists to produce
npm run compass -- explain owner/name      # per-PR evidence behind one repo's numbers
npm run compass -- status                  # corpus counts, journal, recent runs + budget usage
npm run compass -- serve                   # JSON API over the reports, for the UI
```

Useful flags: `--limit N` (cap repos touched), `--repo owner/name` (single repo),
`--stale-hours N` (metadata refresh window, default 24), `--stale-days N` (metrics refresh window,
default 7), `--only id,id` (specific seed queries), `--backfill-max-pages N` (raise for repos with
thousands of open issues), `--sort median|ignored|stale|reviewed|merge`, `--min-prs N`,
`--bucket dormant|slow|moderate|responsive`.

First run, in order:

```bash
npm run compass -- seed --dry-run     # sanity-check the queries first
npm run compass -- seed
npm run compass -- sync repos
npm run compass -- sync issues        # the expensive one; safe to interrupt
npm run compass -- sync metrics --limit 20   # start small and read the output
npm run compass -- maintainers
npm run compass -- status
```

## Defining the corpus

`src/seeds/queries.ts` is the file you keep editing. Each entry builds a GitHub search query and
carries an `id` that lands in `repos.discovered_via`, so you can later ask which queries actually
produced repos you contributed to, and retire the ones that never do.

Search caps any single query at 1,000 results however you paginate, so breadth comes from many
narrow queries rather than one broad one. The default set targets the 1k–30k star band on purpose:
below roughly 500 stars, abandonment risk dominates; above roughly 50k, labelled beginner issues
are claimed within hours.

## How incremental sync works

**Repo metadata** comes from `/repos/{owner}/{name}`, which has a stable URL — so a stored ETag
turns unchanged repos into `304 Not Modified`, and **304s cost no quota at all**. Repos are also
staleness-gated (`--stale-hours`), so a routine run skips most of the corpus outright.

**Issues** run in two modes per repo:

- *Backfill* (first pass): `state=open`, sorted by `created` ascending. `created_at` never changes,
  so pagination stays stable even while the tracker is active. Sorting by `updated` mid-write is
  how you silently skip pages.
- *Incremental* (thereafter): `state=all` with `since` set to `repos.issues_synced_at` minus a five
  minute overlap. Asking for `all` rather than `open` is what lets a locally-open issue learn it was
  closed — closing bumps `updated_at`, so it returns through the same window.

Repositories with more open issues than the per-run page cap resume rather than restart.
`issues_backfill_page` records how far the backfill got, and because pages are ordered by
`created_at` ascending — which never changes for an existing issue — an earlier page cannot shift
under you, so the page number is a stable cursor. Without it, projects like elastic/kibana burned the
same twenty pages on every run and never finished.

Text is stripped of NUL characters before insert. Postgres rejects NUL in `text` columns and rejects
the `\u0000` escape that `JSON.stringify` emits for it in `jsonb`, and one such byte in one issue
body fails the whole batch — which cost an entire repository's issues before it was caught.

The watermark only advances when a repo's pages all landed. Two consequences worth knowing:

- A truncated **backfill** does *not* mark the repo backfilled. Flipping it would switch the repo to
  incremental mode and permanently strand the open issues never reached.
- A truncated **incremental** pass advances the watermark only as far as the newest `updated_at`
  actually seen, not to wall-clock now. Since results arrive oldest-update-first, anything beyond
  that point is still ahead of the watermark and arrives next run.

So an aborted run — rate budget, network, Ctrl-C — resumes without a gap.

The REST issues endpoint returns pull requests as issues. `pull_request` is the only reliable
discriminator, and forgetting it silently doubles the corpus with PRs. `src/sync/issues.ts` filters
on it; `issues` holds issues only.

## Maintainer responsiveness (Slice 2)

Most external contributions fail because nobody reviewed them, not because the contributor lacked
skill. So this measures attention, not difficulty.

For each repo it pulls the last 40 pull requests and keeps only the ones that teach you something
about being an outsider:

- **Insider PRs are discarded** (`OWNER`, `MEMBER`, `COLLABORATOR`). Maintainers merging their own
  work says nothing about your experience.
- **Bot PRs are discarded.** This matters more than it looks: a repo with Dependabot enabled produces
  a stream of PRs auto-merged in minutes without human review, which would make a dormant project
  look extremely responsive.
- **A "response" means a maintainer**, not any human. Replies from fellow outsiders measure community
  chatter, not whether anyone with merge rights is paying attention.

### The censoring trap

`median_hours_response` is computed over external PRs that *got* a response. That right-censors the
sample, and the failure mode is severe: a dead repo where 2 of 40 external PRs got a fast reply and
38 were ignored has an **excellent** median. Sorting on it alone would rank the worst repos first.

This is why `no_response_rate`, `open_stale_rate` and `hours_since_last_review` exist, why
`classifyResponsiveness` checks dormancy *before* speed, and why the `maintainers` table always
prints `ignored` beside `median`. There is a test named after this exact case.

### Calibration corrections (found by running against a real 1,000-repo corpus)

Three errors only visible with live data:

**A merge is attention.** Repos that squash-merge external PRs without commenting were scoring
100% ignored alongside a 100% merge rate — incoherent. `firstResponseAt` now includes `mergedAt`,
and `mergedBy` is fetched so an automated merge queue does not read as a human paying attention.

**A PR opened this week is not evidence of neglect.** `no_response_rate` now excludes unanswered PRs
younger than `grace_days` (default 7) instead of counting them as ignored — a fixed-horizon
denominator (`decidable_prs`). Without it the ignore rate punished a repo for however busy the last
week happened to be; on one real repo it inflated 23% to 32%.

**Bot accounts that are ordinary users.** GitHub Apps are identifiable (`__typename` of `Bot`, or a
`[bot]` login suffix); a welcome bot running on a normal account with a MEMBER association is not.
Those produced 0-hour medians on plainly dormant repos. Suffix heuristics catch most
(`grafanabot`, `welcome-bot`, `project-ci`), and `responders` finds the rest empirically:

```bash
npm run compass -- responders
```

Any account with dozens of responses at a near-zero median across several repos is automation. The
report flags them and prints the `COMPASS_IGNORE_LOGINS=` line to paste into `.env`, then:

```bash
npm run compass -- sync metrics --stale-days 0 --limit 2000    # recompute everything
```

`--stale-days 0` means "ignore freshness, recompute now"; pair it with a `--limit` large enough to
cover the corpus or it only does the default 200.

Worth noting what held up: all four repos with corrupted 0-hour medians were still classified
`dormant`, because dormancy is checked before speed. The ordinal verdict survived garbage input,
which is the entire reason it is ordinal.

### Second calibration pass

Four more corrections, all from reading real output:

**Comments are a sign of life.** Prow-based projects (Kubernetes and friends) approve via `/lgtm`
comments and let a bot perform the merge. Liveness originally counted only reviews and merges, so
these landed in `dormant` with a **0% ignore rate and a 100% merge rate**. Maintainer comments now
count toward `hours_since_last_action`.

**A tiny open-PR denominator can no longer force dormancy.** `open_stale_rate` is a ratio over open
PRs only. A project that merges everything within the hour but has three open PRs, two of them
ancient, scored 67% stalled and was called dormant. The rule now requires at least 5 open PRs and a
70% threshold.

**A median needs support to mean anything.** Rows showing `0h` medians alongside 90%+ ignore rates
were medians over a single response. The `maintainers` table now prints a `resp` column beside `n`,
and the classifier returns `unknown` rather than a confident bucket when fewer than 3 external PRs
were answered.

**Ordering matters in the classifier.** The ignore rate is checked first, then liveness, then the
stale backlog, and only then response speed. Neglect is disqualifying however fast the few answers
arrived.

### Third pass: the bot heuristic was too aggressive

A `/bot$/` rule matched the human logins **klembot, abbot, talbot, elliotbot**. Discarding a real
maintainer's merges and comments made an active project report `resp 0`, `ignored 100%`, `last rev —`
and a `dormant` verdict — the worst possible failure, since the whole point is to find live projects.

Suffix matching now requires a separator (`-bot`, `_bot`, `.bot`, `-robot`, `-ci`), known named
automation is listed explicitly (`grafanabot`, `k8s-ci-robot`, `mattermod`, …), and anything else is
caught behaviourally via `responders` plus `COMPASS_IGNORE_LOGINS`. The asymmetry is deliberate: an
undetected bot inflates one median and shows up in the report, while a misdetected human makes a
healthy repo look dead.

`status` now checks the invariant that caught this. A merge is a response, so `merged_prs > 0` with
`responded_prs = 0` is only legitimate for merge-queue automation; anything else means a human merger
was read as a bot, and `status` prints the offending repos.

### Fourth pass: authorAssociation is not a maintainer test

`authorAssociation` only reports `MEMBER` when the org membership is **public**. Maintainers with
private membership come back as `CONTRIBUTOR`, so an association-only insider check made them
invisible — entire organisations (EleutherAI, Uniswap, jupyter, ossf, neo4j, …) reported 0 responses
and 0 merges across 40 external PRs and were classified `dormant`. Repos whose maintainers happen to
have public membership worked fine, which is exactly why it looked like real dormancy.

Each repo now gets a **maintainer roster**, built before any PR is scored, from three sources in
descending directness:

1. `assignableUsers` — users who can be assigned to issues and PRs, i.e. holders of triage or write
   access. Public information for public repos.
2. Anyone who merged a PR in the sample. Merging requires write access, definitionally.
3. Anyone the API did label `OWNER`, `MEMBER`, or `COLLABORATOR`.

A response counts if the actor is rostered *or* association-labelled. The roster also reclassifies PR
authors, since otherwise a privately-a-maintainer contributor's own PR counts as external and its fast
merge flatters the numbers. `explain` prints the roster size — a count of 0 is why a repo could show
no responses at all.

### Ordinal verdicts, not scores

`responsiveness` is one of `unknown | dormant | slow | moderate | responsive`, and `confidence` is a
sample-size bucket from the external-PR count. No 0–100 number, because nothing here supports that
precision — the thresholds in `src/metrics/compute.ts` are opening guesses. `confidence = low` means
fewer than 5 external PRs: anecdote, not measurement, and the table shows it so you can distrust the
row. Recalibrate against the decisions journal once it has rows; that is the only honest source of
truth about which buckets predicted your outcomes.

`repo_metrics.detail` keeps every per-PR observation, so `explain owner/name` traces any headline
number back to the PRs that produced it. Worth using early: some projects run triage teams whose
members show up as `CONTRIBUTOR`, and the strict maintainer filter reads that as silence.

### Why GraphQL here

Over REST this needs `/pulls/{n}/reviews` plus `/issues/{n}/comments` per PR — roughly 2 × 40 × 500 =
**40,000 requests** against a 5,000/hour limit. Infeasible. One GraphQL query carries a batch of
repos as aliases, and cost is read back from the response's `rateLimit` block, so budget accounting
is measured rather than estimated.

Batching does not reduce the point cost (GitHub sums the aliases) but it cuts round trips. A batched
query answers with HTTP 200, nulls for the aliases that failed, and an errors array carrying the
path — so one deleted repo does not discard its batch-mates.

| | points |
|---|---|
| per repo: 40 PRs × (8 reviews + 5 comments) ≈ 560 nodes | ~6 |
| a 200-repo run | ~1,200 of 5,000/hour |
| a 500-repo corpus under the 7-day staleness gate | ~70 repos/day, a few hundred points |

Maintainer behaviour moves slowly, so a week-old metric is still a good metric. That staleness gate
is what makes this cheap enough to run alongside everything else.

## Setup complexity (Slice 3)

Answers the other half of the five-hours question: not *will anyone review this*, but *how long
before I can even run the tests*.

Everything is read from files at the default branch HEAD, and everything reported is a fact you can
check against the repository in seconds — which is the point. There is no LLM and no inference about
intent: a compose file either declares seven services or it does not.

```bash
npm run compass -- sync setup --limit 50
npm run compass -- setup --sort weight
npm run compass -- setup --weight light --max-services 2
```

What it reads: compose service count and the backing services implied by their images (Postgres,
Redis, Kafka, …), Dockerfile and devcontainer presence, declared runtime versions from
`package.json` engines / `.nvmrc` / `.tool-versions` / `pyproject.toml` / `go.mod` / `Cargo.toml` /
`pom.xml`, package manager, monorepo markers, variable count in the env template, `CONTRIBUTING.md`,
task runner (`make`/`task`/`just`), workflow count, and whether CI triggers on pull requests.

Three deliberate choices:

**Facts, not minutes.** "7 services, needs Postgres and Kafka, 14 env vars, Node ≥22" is actionable.
"35 minutes" is a guess, and the third time setup takes three hours you stop believing the number —
then you stop believing the whole report.

**`—` is not `0`.** A null service count means no compose file was found; a null env count means no
template exists. Reporting those as zero would make an unreadable repo look like a simple one.
`tree_truncated` marks repos where GitHub would not serve the listing, and there `false` in any
`has_*` column means "not seen".

**Mitigations are reported beside the weight, never folded in.** A heavy project with a devcontainer
and a Makefile is a different proposition from a heavy one with neither, and averaging them into one
score destroys exactly the distinction that matters.

### Known limitation: root-level files only

Every path is read at the repository root. A compose file under `docker/`, `server/`, `deploy/` or
`contrib/` reads as **absent**, so `svcs` shows `—` and the weight comes out lower than reality.

This systematically understates large monorepos — exactly the projects where setup is hardest.
Mattermost coming back `light` is this limitation, not a healthy signal. Treat `light` on a big
multi-component project as "not measured" rather than "easy".

Fixing it properly means one REST call per repo to `git/trees?recursive=1` to locate compose files
anywhere in the tree, then a second pass to fetch the ones found. That is roughly 1,000 extra REST
requests for a 1,000-repo corpus (about 20% of the hourly core budget) plus a second round trip, and
it is the obvious next improvement if `light` verdicts keep being wrong.

Cost is low: one query per batch of 3 repos, and blob text does not count toward rate-limit points
the way connection nodes do. Batch size is small because the constraint here is response size, not
points. Layout changes slowly, so the staleness gate defaults to 30 days.

## Ranked shortlist (Slice 4)

The output the whole thing exists to produce: which open issue is worth the next five hours.

```bash
npm run compass -- shortlist
npm run compass -- shortlist --labelled --max-setup moderate --language TypeScript
npm run compass -- why owner/name#123
```

### The breakdown is the product

The score has no units and predicts nothing. It orders candidates according to the weights in
`src/rank/weights.ts`, and `why` itemises every line with the raw value behind it:

```
  +  22  responsiveness    responsive, median 6h
  +  18  onboarding        devcontainer, make, CONTRIBUTING, CI on PRs
  +  16  merge rate        75% of 16 decided outside PRs merged
  +  16  invited           labelled "good first issue"
  ...
   -26  merge rate         8% of 16 decided outside PRs merged — answers, then closes
```

That is deliberate, and it is the opposite of the "Overall Confidence: 86%" in the original spec. A
fabricated measurement cannot be argued with; a weighted preference function can. When a
recommendation is wrong you can see which line lied, and you change it in one file.

### Diversity and scope, learned from the first real run

Two corrections the first live shortlist forced:

**One repository took twelve of the top twenty rows**, all on an identical score. Repo-level signals
(responsiveness, merge rate, setup, language) sum to about 80 points while issue-level variation is
worth a handful, so the ranking was effectively ordering repositories. `--per-repo` (default 2) caps
rows per project and reports how many were held back. A shortlist is a set of distinct options.

**An epic ranked second.** "Master FR: Pen, Stylus, Handwriting, and Drawing Tablet Support" carried a
`good first issue` label and scored 109. Nothing in the score knew the difference between that and a
one-line documentation fix, and the `detailed` bonus rewarded its length. `SCOPE_PATTERNS` now reads
the title for feature-request, RFC, epic, umbrella and rewrite markers, and a body past 5,000
characters is treated as a specification rather than a task.

**Every row showed the same three signals.** Repo lines carry the largest weights, so a breakdown
sorted by magnitude read `+22 responsiveness +16 merge rate +16 invited` on nineteen of twenty rows —
explaining why the *project* was good and nothing about why one issue outranked another, while
duplicating facts the context line already stated. Each score line now records whether it is `about`
the repo or the issue; the compact view shows issue lines only, and `why` splits the breakdown into
"the project" and "this issue" with separate subtotals.

**An issue mill took two of the top five.** A small app with issue numbers in the twenty-six
thousands, titles like `[Good First Issue] Add new Video Game Quote 50`, a dozen opened the same day,
eighteen more queued. Every per-issue signal read as excellent — invited label, no comments,
maintainer-filed, fresh, fast responses — because the pattern is only visible *across* issues. So
`buildRepoContext` derives per-repository facts from the candidate set itself (no extra queries), and
a burst of eight or more invited issues inside a week costs 35 points. A penalty rather than a gate:
heavy enough to clear the top, visible in the breakdown, and survivable for a legitimate project
running a labelling sprint.

`why` builds the same context, or a milled issue would look fine when inspected alone.

The score range is printed with every run. If it is narrow, the weights are not discriminating and
the honest response is to change them rather than trust the order.

### Hard gates versus preferences

Gates live in SQL and eliminate; weights live in the score and rank. An assigned issue is not a weak
candidate, it is somebody else's work — excluded, not penalised. Same for `dormant` repos, locked
issues, and anything already in the decisions journal.

### Merge rate lives here, not in the responsiveness bucket

Observed in the corpus: a project answering every outside PR within two hours and closing ten of
sixteen unmerged. Slice 2 calls that `responsive` and is right to — someone is home. But it is a bad
place to spend five hours, and the two facts need to stay separable rather than being averaged into
one verdict. So `responsiveness` answers "is anyone home" and `merge rate` answers "will my work
land", and the ranking weights them independently.

### The journal closes the loop

```bash
npm run compass -- decide owner/name#123 rejected --reason "needs design discussion first"
npm run compass -- decide owner/name#456 started --hours 4
npm run compass -- decide owner/name#456 merged --actual-hours 11
npm run compass -- journal
```

Deciding removes an issue from future shortlists, which is what keeps the list from showing you the
same rejected row every morning. After a handful of estimates `journal` reports how far your
predictions run from reality — the first honest number in the entire system, because it is measured
against outcomes rather than asserted.

Nothing infers from the journal yet. With a few dozen rows it becomes the basis for retuning
`weights.ts`, which is the only defensible way those numbers stop being guesses.

## The interface

The UI is a thin client over the endpoints below; every judgement it displays was made server-side.
Two rules from this project's design principles drive the whole visual system, and both are worth
preserving if you change it:

**Nothing ordinal is drawn as continuous.** Responsiveness (`dormant | slow | moderate | responsive`)
and setup weight (`light | moderate | heavy`) are buckets, so they render as discrete stepped cells
plus the word itself — never a percentage, a gauge, or a smooth bar. Lit cells mean *more* of the
thing; the colour says whether more is good (attention, in ink) or costly (setup, in ochre).

**The evidence outranks the score.** The score sits in the corner of each row labelled `NO UNITS`.
The emphasis a dashboard would spend on a big number goes instead to the *provenance bar*: a
to-scale split of how much of the score came from the project versus from this issue. Repo weights
dominate the ranking, so a 104 that is 82 project and 22 issue is a recommendation of the repository,
not of the task — and that is the single most useful thing to know before opening a candidate. It is
invisible in the evidence chips because those are capped at four lines, which is why `ShortlistRow`
carries `subtotals` separately.

Credits are indigo and debits are ochre rather than green and red, deliberately. A negative line is
not a moral failing; it is a preference function subtracting points, and green/red would assert a
judgement the data does not support.

An unmeasured value renders as `—`, everywhere, with a tooltip saying so. Reporting absence as zero
is what makes unreadable projects look simple.

The calibration figure on the journal screen is withheld below three complete prediction/outcome
pairs — the client is not permitted to average the entries itself, and the server sends `meanRatio:
null` until the threshold is met. Below it the screen shows progress toward the threshold instead.

## JSON API, and the layering rule it imposes

`npm run compass -- serve` starts a Fastify server on `127.0.0.1:8787`. It exists so the UI can read
the same data the CLI prints, and it is deliberately thin — it parses query strings, maps a few error
shapes onto status codes, and serialises.

```
GET  /api/shortlist?limit=20&min-score=20&per-repo=2&language=TypeScript
                   &labelled&max-setup=moderate&min-stars=500&include-dormant
GET  /api/issues/:owner/:name/:number/why
GET  /api/journal?limit=30
POST /api/decisions   {"ref":"owner/name#123","verdict":"started","predictedHours":4}
GET  /api/verdicts    the workflow vocabulary, so the UI keeps no copy of its own
GET  /api/health
```

Query parameters are named after the CLI flags on purpose. The CLI is the fastest way to debug this
system, and being able to transcribe a failing URL into a command line without a translation table is
worth the slightly un-idiomatic hyphens.

**Reading the corpus does not need a GitHub token.** `migrate`, the CLI reports, the API and the
whole UI need Postgres and nothing else; only syncing reaches GitHub, and only that path demands a
token. Restoring a database onto a machine without one should not stop you reading it.

**Bound to localhost, no auth.** `POST /api/decisions` writes, and binding `0.0.0.0` would put an
unauthenticated write endpoint on the network. `COMPASS_HOST` and `COMPASS_PORT` override, but think
before you do. GitHub OAuth belongs with the multi-user phase, and adding it now would be scaffolding
for a requirement that does not exist.

### Three layers, and what each is forbidden from doing

The ranking commands used to query Postgres, apply judgement, and format terminal output inside one
function. That made the judgement untestable: the per-repo cap and the journal's accuracy threshold
were only reachable by running the whole command against a live database and reading the text.

```
rank/view.ts     PURE. Presentation models. No database, no console, clock injected.
rank/data.ts     Queries. Returns view models. No formatting.
rank/render.ts   Terminal output. Every value already computed.
http/server.ts   JSON. Every value already computed.
```

- **`view.ts` may not import `db.ts`.** It holds the per-repo cap, the summary statistics, the
  repo/issue split behind `why`, and the prediction/outcome pairing — all judgement, all now under
  test against fixtures.
- **`data.ts` may not format.** An empty candidate set is a returned value with a notice on it, not
  an early `console.log` and a bare `return`. That is what made the empty cases reachable from HTTP
  at all.
- **Renderers own their own prose.** Notices come out of the view as structured kinds
  (`no-candidates`, `none-scoring`, `fetch-cap-hit`) rather than sentences, because the CLI's remedy
  is a flag to retype and the UI's is a control to move. The one thing a renderer may never do is
  decide to show a number the view withheld — see `MIN_PAIRS_FOR_MEAN`.

The same split has **not** yet been applied to `report.ts` (`maintainers`, `responders`, `explain`,
`setup`). It is the same mechanical change repeated four times.

### Two things the split shook out

- `assembleShortlist` was not threading `now` into `rankCandidates`, so issue age and the issue-mill
  window scored against wall-clock time. Harmless in production, but no fixture could be scored
  reproducibly, which is precisely why nobody had noticed.
- A predicted `0` hours produced `Infinity` and rendered as "Infinityx your prediction". `hoursRatio`
  now returns null, and the journal reports it as an incomplete pair.

## Pruning before backfilling

Issue backfill is the expensive step — roughly three REST requests per repo, and a thousand repos is
most of an hour's budget and a quarter of a million rows. Slices 2 and 3 exist to identify which of
those repos you would never contribute to, so run them first and pause the rest.

```bash
npm run compass -- prune                      # dry run: shows what would be paused and the saving
npm run compass -- prune --apply
npm run compass -- prune --heavy --apply      # also drop heavy-setup projects
npm run compass -- prune --unpause --apply    # reverse the lot
```

Nothing is deleted. `sync_state = 'paused'` stops issue and metric syncing and is fully reversible.
Two safeguards: a `dormant` verdict only prunes at `medium` or `high` confidence, so thin samples
cannot quietly discard a repo, and no repo is paused if the journal shows live work in it.

## Where the slices stop

The five-slice plan is complete. Slice 5 — the decisions journal — is the `decide` and `journal`
commands; there is no separate module.

Deliberately not built, from the original specification: the readiness score, the contribution
simulator, the learning feedback loop, notification and evaluation engines, and the PR assistant.
Each of those either needs calibration data the journal does not have yet, or predicts something no
data here supports predicting. The honest sequence is: use this daily, accumulate a few dozen decided
rows, and let those decide what earns building next.

## Rate budget

Two separate buckets: `core` at 5,000 requests/hour for a token, `search` at 30/minute. The client
tracks them independently from the `x-ratelimit-resource` header, because conflating them is how you
get surprise 403s. When a bucket nears its floor the run stops cleanly and records
`status = 'aborted_budget'` rather than dying mid-repo.

For a 500-repo corpus, a routine `sync all`:

| step | requests |
|---|---|
| repo metadata, 24h staleness gate | ~100–500, many of them free 304s |
| issue sync, mostly quiet repos | ~500–700 |
| **total** | **~1,000 ≈ 20% of the hourly core budget** |

The one-time cold backfill is the expensive part — roughly `ceil(open_issues / 100)` requests per
repo, so on the order of 1,500 for a corpus averaging 250 open issues each. It fits in one hour and
resumes if it doesn't.

`status` prints billed requests as a percentage of the core limit per run. That's the Slice 1 exit
check: **a cold run populates, a second run is incremental, and no run exceeds 60% of budget.**

## Schema

`repos`, `issues`, `repo_metrics`, `sync_runs`, `decisions`. Every repo and issue row keeps the
verbatim API payload in a `raw` jsonb column — you will change your mind about which fields matter,
and re-fetching is the expensive part, while reshaping from `raw` is free. Budget roughly 3–5 KB per
issue.

`decisions` is Slice 5's journal, created early so you can start logging by hand immediately:
verdict, your predicted hours, actual hours, and why. Nothing infers from it yet. With a few dozen
rows it becomes the only honest evidence about which signals actually predicted your outcomes — and
the basis for recalibrating the Slice 2 thresholds.

`setup_facts` is still absent; its columns are a Slice 3 decision, and guessing now would be worse
than adding a migration later.

## Cron

```cron
15 * * * * cd /path/to/opensource-compass && /usr/bin/npm run compass -- sync all >> sync.log 2>&1
```

Hourly is comfortable: both staleness gates keep most hours cheap, and every run is resumable.

## Deviations from the stack document

- **`pg` and plain SQL migrations, not Prisma.** The sync does multi-row `ON CONFLICT` upserts,
  which is where raw SQL is genuinely better, and it keeps codegen out of the loop. When the Slice 4
  UI arrives, `prisma db pull` introspects this schema cleanly.
- **REST only, no GraphQL.** See the budget table — REST is comfortable at this corpus size.
  GraphQL batching earns its complexity in Slice 2, where per-PR review data over REST would not be.
- **No Redis, BullMQ, NestJS, or Docker Compose.** Nothing here needs retry semantics a cron entry
  can't provide. Add them when a job actually does.

## Known limits

- A repo renamed such that something else claims its old `owner/name` is handled (`full_name` is
  deliberately not unique; the numeric id is the identity), but the stale row lingers until its next
  metadata refresh.
- Issues that are deleted or transferred between repos are not detected; they stay in the corpus
  until you next touch that repo's history. Rare enough to ignore for now.
- Search results are slightly thinner than the single-repo endpoint, so `seed` deliberately leaves
  `meta_synced_at` null and lets `sync repos` fill in canonical metadata on its next pass.
- A repo that becomes archived, disabled, or loses its issue tracker is moved to
  `sync_state = 'paused'` so it stops consuming budget. Five consecutive failures pause a repo too.

## Verification status

What has been checked:

- **194 unit tests** (`npm test`) over the pure modules: the metric statistics (the censoring
  trap, bot and insider exclusion, right-censored medians, merge-rate denominators, clock skew,
  empty input), the file parsers, the scoring, the shortlist assembly (per-repo cap, held-back
  counts, score range over the scoring set rather than the shown set, fetch-cap detection), the
  journal's refusal to average fewer than three prediction/outcome pairs, and the HTTP layer's
  query coercion and error mapping.
- **The generated GraphQL query is parsed and validated** against a schema for batch sizes 1–20, so
  a misspelled field or undeclared variable fails here rather than mid-run.
- **All SQL is parsed against the real PostgreSQL grammar** (libpg_query), including the dynamically
  generated upserts, and the `repo_metrics` column list is cross-checked against the migration.
- Typechecks under `strict` plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and
  `erasableSyntaxOnly` (which guarantees Node can run the TypeScript untransformed).
- **The data/render split was verified by diff, not by inspection.** The pre-refactor and
  post-refactor CLI were run against the same fixture corpus across nine command variations,
  including the empty, none-scoring and fetch-capped paths. Output is byte-identical except for
  one line where a hardcoded "Three" became the constant it should always have read from.

What has **not** been checked: nothing has run against live GitHub or a live Postgres. That first run
is yours. `seed --dry-run`, then `sync metrics --limit 20`, then reading `explain` output on two or
three repos you already have opinions about, is the cheap way to find out whether the maintainer
filter behaves sensibly on your corpus.

## Slice 2 exit check

```bash
npm run compass -- maintainers --sort median
npm run compass -- maintainers --sort ignored --min-prs 5
```

The criterion is judgement, not a number: **the bottom of that list should match your intuitions
about which projects are abandoned.** If a repo you know to be lively lands in `dormant`, run
`explain` on it — the usual cause is a triage team whose reviewers are not `MEMBER`, which is a
threshold to adjust rather than a bug.
