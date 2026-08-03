# How ranking works

Read this before you trust a number, and definitely before you change one.

---

## The one thing to understand first

**The score has no units and predicts nothing.** It exists to put candidates in order. A 104 is not
twice as good as a 52, it does not mean 104 of anything, and it is not a probability, a percentage, or
an estimate of hours.

The useful output is the **breakdown**, not the total. Every line carries the raw value that produced
it, so you can look at `+16 invited (labelled "good first issue")` and decide for yourself whether that
deserves 16 points. If you disagree, the number lives in `src/rank/weights.ts` and you should change it.

Everything below is arranged so you can tell what is measured from what is assumed, because those
deserve very different amounts of trust.

---

## Measured versus assumed

| | What it is | How much to trust it |
|---|---|---|
| **Maintainer attention** | Derived from 180 days of real pull requests | **Measured.** Corrected through six rounds against a 1,000-repository corpus |
| **Setup cost** | Derived from files actually in the repository | **Measured** across the whole file tree. See [the caveats](#setup-cost-is-now-read-from-the-whole-tree) |
| **Issue signals** | Labels, body length, comments, age | **Observed facts, assumed meaning.** That a thin body means a slow start is reasoning, not data |
| **The weights** | The point values below | **Assumed.** Never validated against an outcome |
| **Your preferences** | Languages, topics, avoid terms | **Yours.** Not a measurement at all |

The two columns that matter most — responsiveness and setup — went through real correction against real
data. The weights that turn them into points did not. That asymmetry is the honest state of the tool.

---

## Hard gates versus weights

Two different mechanisms, and the difference is deliberate.

**Gates eliminate.** Applied in SQL, before scoring. Nothing gets a score at all if it fails one:

- The issue is closed
- The issue is assigned to somebody
- The issue thread is locked
- You have already recorded a decision about it
- The repository is dormant — nobody answers external pull requests (unless `--include-dormant`)
- The repository is paused by `prune`

An assigned issue is **someone else's work, not a weak option.** Ranking it low would still put it in
front of you.

**Weights rank.** Everything else is points, and points are always visible in the breakdown. A penalty
never silently removes something — you can always see why a row is where it is.

---

## The signals

All values from `src/rank/weights.ts`. Every one has a comment there explaining its reasoning; this is a
summary.

### Maintainer attention — the repository

The heaviest signals, because this is the thing that most determines whether your five hours produce
anything.

| Signal | Points | Condition |
|---|---|---|
| Responsiveness: `responsive` | **+22** | Outside PRs get answered quickly |
| Responsiveness: `moderate` | +14 | |
| Responsiveness: `slow` | +5 | |
| Responsiveness: `unknown` | 0 | Not measured — **not** penalised |
| Responsiveness: `dormant` | −40 | Also a hard gate; the penalty is a backstop |
| Merge rate: generous (>60%) | +16 | Of *decided* external PRs, at least 6 of them |
| Merge rate: mixed (>30%) | +7 | |
| Merge rate: unwelcoming (<15%) | **−26** | Answers, then closes |
| Ignore rate above 40% | −12 | Most outsiders simply never get a reply |

**Merge rate is separate from responsiveness on purpose.** The corpus contained a project answering
every outside PR within two hours and closing ten of sixteen unmerged. Fast triage is not a project that
lands your work, and it reads as `responsive` either way. Collapsing the two would have lost that.

**Thin samples are halved.** A `responsive` verdict from four external PRs is not the same claim as one
from thirty, so repository signals are multiplied by 0.5 when confidence is low.

### Setup cost — the repository

| Signal | Points |
|---|---|
| `light` setup | +12 |
| `moderate` setup | +3 |
| `heavy` setup | −14 |
| `unknown` setup | **0** |
| Has a devcontainer | +6 |
| Has a task runner (make, just, npm scripts) | +3 |
| Has a CONTRIBUTING file | +4 |
| CI runs on pull requests | +5 |

`unknown` scores zero, not negative. **Do not let a limitation masquerade as a finding** — an unmeasured
repository is unmeasured, not complicated.

The mitigations are counted separately from the weight because a heavy project with a devcontainer and a
Makefile is a genuinely different proposition from a heavy one with neither.

### The issue itself

| Signal | Points | Condition |
|---|---|---|
| Invitation label | +16 | `good first issue`, `help wanted`, `up-for-grabs`, and similar |
| Tractable label | +5 | `documentation`, `bug`, `test` — only if not already invited |
| Avoid label | −14 | `needs-design`, `blocked`, and your own additions |
| Uncontested | +6 | 3 comments or fewer |
| Contested | −10 | 12 comments or more |
| Fresh | +5 | Opened within 45 days |
| Stale | −10 | Open more than a year |
| Filed by a maintainer | +6 | Tends to be specified well enough to start on |
| Thin body | −8 | Under 200 characters |
| Substantial body | +3 | Over 600 characters |
| Sprawling body | −12 | Over 5,000 characters |

**Comment count as a contention proxy.** A quiet issue is probably unclaimed. A busy one is usually
either already being worked by someone who did not self-assign, or a design argument you would be
walking into.

**The sprawling penalty exists because of a real failure.** Rewarding body length without a ceiling
pushed epics to the top — one titled `Master FR: Pen, Stylus and Handwriting support` ranked highly
because it was thoroughly written. Past a certain length a body is a specification, not a task.

### Project size

| Signal | Points | Condition |
|---|---|---|
| Sweet spot | +4 | 1,000–30,000 stars |
| Very large | −6 | Over 60,000 stars |

Very large projects have crowded queues and long review chains. Very small ones carry abandonment risk
the responsiveness metrics may not have caught yet.

### Issue mills

| Signal | Points |
|---|---|
| Issue mill pattern | **−35** |

Repositories that auto-generate large numbers of trivial tasks labelled `good first issue` so
contributors can farm activity counts. Triggered by 8 or more invitation-labelled issues opened within
7 days.

One took two of the top five slots on a real shortlist with eighteen more queued: issue numbers in the
twenty-six thousands for a small app, titles like `Add new Video Game Quote 50`, a dozen opened the same
day. **Every individual signal read as excellent** — invited label, uncontested, maintainer-filed,
fresh, fast responses. The pattern only exists *across* issues, which is why this needs repository
context rather than per-issue fields.

A penalty rather than a gate: heavy enough to clear the top of the list, but still visible in the
breakdown, because a legitimate project running a labelling sprint could trip it.

### Your preferences

Set on the **What you want** tab. Capped at ±25 points each.

| Signal | Points |
|---|---|
| Language match | your value, default `TypeScript`/`Python` 14, `Go` 8, `JavaScript`/`Java` 6, `Rust` 4 |
| Topic match | your value |
| Avoided topic | −14 |
| Avoided label | −14 |

Three rules worth knowing:

**Unlisted languages score zero, not negative.** An unfamiliar language is a cost, not a
disqualification, and the setup and responsiveness signals already carry the real risk.

**Setting any language replaces the defaults wholesale.** Deleting TypeScript from your list means it
stops scoring — not that it quietly reverts to 14.

**Topics pay once, at the best rate.** A repository tagged `react` + `frontend` + `typescript` would
otherwise collect three payments for one fact about itself and out-rank a better project carrying fewer
tags.

**The ±25 cap.** The largest measured weight is 22. A preference that outranks every measurement turns
the ranking into a filter — and there are already real filters, which is the right tool for excluding
things.

---

## The per-repository cap

Repository signals dominate, so without a cap one good project takes over the list. On a real run,
**twelve of the top twenty came from the same repository, all on an identical score.**

The default cap is 2. Rows show `+8 more scoring issues in this project, held back by the cap` so you
know the alternatives exist.

This is also why `total` in the API response differs from `scoring`: 400 scoring issues in 30
repositories offer 60 pageable rows at a cap of two.

---

## The provenance split

Every row reports how much of its score came from the project versus from the issue:

```
the project +82   this issue +22
```

This is the most useful thing on the row and it is not derivable from the visible evidence lines, which
are capped at four.

**If nearly everything came from the project**, the tool is recommending the *repository*. Any of its
issues would serve, and you should probably look at the others. **If a real share came from the issue**,
this particular issue stood out from its siblings.

---

## What "not measured" means

A dash. Never a zero.

`median reply —` means Compass has no data on reply times for that project, **not** that replies are
instant or absent. Unmeasured signals contribute nothing in either direction, and `why` lists them
explicitly:

```
Not measured, and contributing nothing either way: setup, merge rate.
```

Reporting absence as zero is the single easiest way to make a tool like this lie, and it is guarded
against in the type system — the pure modules use `null` for unmeasured and the renderers are tested to
show a dash.

---

## Filtering by what a project is built with

Separate from scoring: this is a gate, not a weight.

`--stack react` reads **declared dependencies** — `package.json`, `pyproject.toml`,
`requirements.txt`, `go.mod`, `Cargo.toml`, `pom.xml` — plus GitHub topics that match a known name.
Every one of those files is already fetched for runtime detection, so this costs no extra API budget.

The point is that it is not a name match. A repository called `awesome-react-tips` is not a React
project. One that declares `react` and is called something else is.

Three deliberate choices:

- **A fixed vocabulary**, currently 34 entries. "Every dependency" would offer forty thousand filter
  options and describe a project by its transitive graph, which is not what "I want to work on React"
  means.
- **Direct dependencies only.** Transitive ones would report React for anything depending on a
  component library.
- **An unrecognised term matches nothing**, not everything. A filter that silently does not filter is
  worse than one that errors.

`js` and `javascript` both include TypeScript; `ts` does not include JavaScript, because the
implication runs one way. `--language` remains an exact match when you need strictness.

## Setup cost is now read from the whole tree

**This used to be a root-only reading**, and it was the most significant inaccuracy in the tool: a
project keeping its `docker-compose.yml` in `build/`, or its env template in `config/`, read as simpler
than it was. `mattermost/mattermost` read as `light`.

The reading now walks the full file tree. Compose files and env templates are found at any depth,
shallowest first, and `setup_facts.compose_depth` records where — a non-zero depth is a row the old
reading got wrong. Vendored and example directories (`node_modules`, `vendor`, `examples`, `docs`) are
excluded, because an example app's compose file is not how you run the project.

Two things deliberately did **not** change:

- **Root-level facts still come from the root.** Makefile, README, CONTRIBUTING, lockfiles. Widening
  those would re-score the whole corpus for reasons unrelated to the bug.
- **A truncated tree yields `unknown`.** GitHub stops listing on very large repositories, and
  concluding "no compose file" from a partial listing is the same wrong answer in a new costume. This
  was a latent bug: `treeTruncated` was accepted by `classifySetupWeight` and never read, which was
  harmless only while it happened to equal `filesSeen === 0`.

---

## Changing the weights

They are all in one file, with reasoning attached:

```bash
$EDITOR src/rank/weights.ts
npm test
npm run compass -- shortlist --min-score 0
```

No rebuild step. Change a number, run the shortlist, see what moved.

Before you do, two suggestions.

**Use `why` on a row you disagree with first.** Often the weight is fine and the underlying measurement
is stale — `sync metrics --repo owner/name --stale-days 0` recomputes one project.

**Record decisions for a while instead.** The weights are unvalidated because nobody has fed the tool
outcomes yet. Fifteen issues with a predicted and an actual hour count would tell you which weights are
wrong far better than intuition will, and the journal is built to collect exactly that.

---

## Where this is implemented

| File | What is in it |
|---|---|
| `src/rank/weights.ts` | Every tunable number, with rationale |
| `src/rank/score.ts` | Pure scoring: candidate in, itemised breakdown out |
| `src/rank/candidates.ts` | The SQL gates |
| `src/rank/profile.ts` | Preference shape, validation, defaults |
| `src/rank/view.ts` | The per-repo cap, pagination, summary statistics |

`score.ts`, `profile.ts` and `view.ts` are pure — no database, no clock, no console — so every judgement
in them is tested against fixtures. See [Architecture](architecture.md).
