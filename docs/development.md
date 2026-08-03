# Development

```bash
npm install
npm run web:install

npm test           # ~230 tests, about two seconds, no database needed
npm run typecheck  # tsc --noEmit
npm run docs:check # documentation against the source
```

All three must pass before anything is considered done.

`docs:check` exists because documentation rots silently and proofreading does not catch it. It verifies
internal links and anchors, every npm script and CLI flag, every documented endpoint against
`server.ts`, the weight values quoted in `how-ranking-works.md`, the preference cap, the verdict list,
the stack vocabulary size, and the migration count. It has caught four real problems: a `--fetch-limit`
flag documented before it existed, a stale anchor after a heading was renamed, two migration counts left
behind when an eighth was added, and a "roughly forty" claim when the vocabulary had 34 entries.

---

## Working on it

### Two terminals

```bash
npm run serve      # API on :8787
npm run web:dev    # Vite on :5173, hot reload, proxies /api to :8787
```

Use `:5173` while working on the frontend. `npm start` builds and serves from `:8787` for normal use.

### Offline, against fixtures

Neither a GitHub token nor a network is needed to work on ranking, rendering, or the UI:

```bash
createdb compass_dev
DATABASE_URL=postgres://localhost/compass_dev npm run migrate
psql compass_dev -f fixtures/dev_corpus.sql
DATABASE_URL=postgres://localhost/compass_dev npm run serve
```

`fixtures/dev_corpus.sql` is small on purpose and every row hits a specific case — the per-repo cap, the
epic penalty, the assigned and locked gates, a dormant repository, a null that must stay null. Reload with
`drop database` rather than truncating: `decisions` rows accumulate and change what the shortlist gates
out.

---

## Testing

`node --test`, no framework. Files sit next to what they test as `*.test.ts`.

**The tests are almost entirely over the pure modules**, which is the point of the architecture — no
database, no network, no clock, so they run in milliseconds and every judgement in the tool is reachable
from a fixture.

Four things are checked in ways worth knowing about:

**SQL is validated structurally.** Statements are parsed against the real Postgres grammar, so a syntax
error fails `npm test` rather than `npm run migrate`. Bind-parameter counts are checked too, after an
off-by-one shipped once.

**GraphQL queries are validated** against a hand-written stub schema, so a misspelled field fails in
tests rather than mid-run against the live API.

**HTTP routes are tested through `app.inject()`**, no socket — but only the paths that fail validation
before the data layer, plus the constant routes. A mocked pool would only assert that the mock behaves
like the mock.

**`RUN_KINDS` is checked against the SQL `CHECK` constraint.** They drifted once and every setup run
failed on insert.

### Writing a test

Assert the reason, not just the value. A test that says what breaks if it fails is worth several that
only say what equals what:

```ts
test('several matching topics pay once, at the best rate', () => {
  // Otherwise a repo tagged react + typescript + frontend collects three payments for one fact
  // about itself, and out-ranks a better project that happens to carry fewer tags.
  const profile = resolveProfile({ ...EMPTY_PROFILE, topicPoints: { react: 8, frontend: 5 } });
  const line = lineFor(candidate({ topics: ['react', 'frontend'] }), 'topic', profile);
  assert.equal(line?.points, 8);
});
```

**Check your assertions are not vacuously true.** `assert.ok(lines.every(l => l.points !== 0))` passes
trivially when `lines` is empty. Print the actual values once while writing the test.

**When a test fails, work out which of the two is wrong before changing either.** One assertion here
claimed a profile-driven line would appear in a row's breakdown. It failed. The code was right: the row's
language was not in the profile, so it correctly scored nothing. The fix was a better test — asserting
both that the matched project gains a line *and* that the unmatched one has none — which is what actually
proves the replace-not-merge behaviour.

### Verifying a refactor

Behaviour preservation is claimed by diff, not by inspection. The recipe:

```bash
# old implementation
git stash && DATABASE_URL=...compass_dev npm run compass -- shortlist --min-score 0 > /tmp/before.txt
git stash pop
DATABASE_URL=...compass_dev npm run compass -- shortlist --min-score 0 > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt
```

Do it across several command variations, including the empty and degraded paths — those are where
refactors break things and where nobody looks.

---

## Conventions

**Comments explain why, not what.** `weights.ts` is the model: every number carries the observation that
produced it. `// increment i` is noise; `// A penalty rather than a gate: heavy enough to clear the top of
the list while staying visible in the breakdown, because a legitimate project running a labelling sprint
could trip it` is the useful kind.

**`null` means unmeasured. Never zero.** This runs from the SQL through the pure modules to the dash in the
interface. Reporting absence as zero is the easiest way to make this tool lie.

**No `process.exit()` on normal paths.** It truncates buffered stdout, so the last lines of a report vanish.

**Bind parameters need static type guards.** Untyped parameters in operator expressions make Postgres fail
type inference. Write `$3::text is null or ...`, not `$3 is null or ...`.

**`--limit` must be positive; staleness flags accept zero.** A limit of zero is meaningless; `--stale-days
0` legitimately means "recompute everything now". `src/params.ts` encodes the distinction once for both
the CLI and the HTTP layer.

**Bad input is refused, not coerced.** `--limit banana` is an error. A quietly-ignored parameter produces
a plausible answer to a question nobody asked.

### TypeScript

`strict`, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and `erasableSyntaxOnly`.

`exactOptionalPropertyTypes` is the one that will surprise you: an absent property and one set to
`undefined` are different types. Build options objects by omission:

```ts
// wrong
const options = { limit: maybeLimit };            // limit?: number | undefined
// right
const options = { ...(maybeLimit !== undefined ? { limit: maybeLimit } : {}) };
```

`src/params.ts` exports `defined()` for this.

`erasableSyntaxOnly` means no enums, no parameter properties, no namespaces — anything Node cannot strip
without transforming. This is what keeps the no-build-step property.

---

## How to add things

### A scoring signal

1. Add the number to `src/rank/weights.ts` **with a comment explaining where it came from.**
2. Add the line in `src/rank/score.ts` via `add(signal, points, detail, about)`. `detail` must carry the
   raw value — `85% of 21 decided outside PRs merged`, not `good merge rate`.
3. If the data is not already on `Candidate`, add it to the interface and to the `select` in
   `src/rank/candidates.ts`.
4. Test it in `src/rank/score.test.ts`, including the unmeasured case: a missing measurement must be
   **absent from the breakdown**, not a zero-point line.

`about: 'repo' | 'issue'` matters — it decides which subtotal the line lands in and whether it appears in
the compact evidence list.

### A migration

See [Database](database.md#writing-one). Forward-only, comment the reasoning, and if you touch a `CHECK`
constraint that TypeScript mirrors, update both.

### An API endpoint

1. The data function goes in `src/rank/data.ts` (or a new data module) and returns a structure.
2. The route in `src/http/server.ts` parses parameters and serialises. **Nothing else.**
3. Query parameters are named after the CLI flags, hyphens included.
4. Test the validation path through `app.inject()`.

### A screen

`web/src/`, one file per screen, wired into `App.tsx`. Reuse the components in `components.tsx` —
`StepMeter`, `ProvenanceBar`, `Ledger` — so the visual grammar stays consistent.

Before adding a control, check the two rules in [Architecture](architecture.md#the-frontend): nothing
ordinal drawn as continuous, and the evidence outranking the score.

### A sync

1. The worker goes in `src/sync/`, wrapped in `withSyncRun` so it gets a `sync_runs` row, budget
   accounting, and the progress heartbeat.
2. Add the kind to `RUN_KINDS` **and** to the `sync_runs.kind` `CHECK` constraint in a migration.
3. Add it to `runner()` in `src/http/jobs.ts` and to `SCANS` in `web/src/Sync.tsx`.
4. Keep the parsing pure and in its own module, as `map.ts`, `metrics_query.ts` and `setup_query.ts` do.

---

## GitHub API notes

Hard-won, all of it from real failures:

- **`authorAssociation` only reports `MEMBER` for *public* org membership.** Per-repo maintainer rosters
  need `assignableUsers` plus merger history.
- **Prow-based projects approve by comment and let bots merge.** Comment liveness signals are essential or
  these look dead.
- **Bot detection by a `bot` name suffix misclassifies real people** — the human login `klembot`, for one.
  Hence the manual `COMPASS_IGNORE_LOGINS` list.
- **Merge queues still count as attention** when bot-authored PRs are excluded upstream.
- **NUL bytes in issue bodies** need a `JSON.stringify` replacer, not a post-serialisation regex.
- **`TypeError: terminated` is undici aborting the response body stream at `.json()`**, not at `fetch()`.
  Both calls must sit inside the retry guard.

---

## Performance

Two things measured at corpus scale (1,076 repositories, ~86,000 issues):

**`why` was scanning the whole corpus per expansion.** It rebuilt the repository context from every
candidate, and that context is per-repo — 2,600ms per click. Scoping the query to one repository took it
to 14ms. `view.test.ts` asserts the invariant that makes it sound: a repository's context derives from its
own issues alone. **If a new signal reads across repositories, that test fails and the scoped query must be
reverted.**

**The 50,000-row fetch cap is reachable.** A corpus that size can hit it, and then the ranking has seen a
recency-ordered subset rather than everything. The `fetch-cap-hit` notice exists for this; do not suppress
it. `shortlist` takes 2–4 seconds at that scale and nothing is indexed for ranking yet, which is the
obvious next optimisation if it starts to grate.

---

## Before opening a pull request

```bash
npm test
npm run typecheck
npm run docs:check
(cd web && npm run build)     # if you touched the frontend
```

Then run the thing against real data and look at the output. Both of the bugs above passed every test.
