# API reference

Base URL: `http://127.0.0.1:8787` by default.

Start it with `npm run serve`, or `npm start` to build and serve the web interface alongside it. Every
response is JSON.

**No authentication.** This is a single-user tool bound to localhost. `POST /api/decisions` and
`PUT /api/profile` write to your database, so do not expose it — see
[Configuration](configuration.md#compass_host).

**Query parameter names match the CLI flags** deliberately, hyphens and all (`min-score`, not
`minScore`). The CLI is the fastest way to debug the system, and being able to transcribe a failing URL
into a command line without a translation table is worth the slightly unusual naming.

---

## Contents

- [Reading the shortlist](#reading-the-shortlist)
- [Explaining one issue](#explaining-one-issue)
- [Recording decisions](#recording-decisions)
- [The journal](#the-journal)
- [Your profile](#your-profile)
- [Languages](#languages)
- [The corpus and syncing](#the-corpus-and-syncing)
- [Utility](#utility)
- [Errors](#errors)

---

## Reading the shortlist

### `GET /api/shortlist`

The ranked list.

**Query parameters** — all optional:

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `limit` | positive int | 20 | Rows per page |
| `offset` | int ≥ 0 | 0 | Rows to skip, after ranking and after the per-repo cap |
| `min-score` | int | 20 | Score threshold. May be 0 or negative |
| `per-repo` | positive int | 2 | Most rows from any one repository |
| `stack` | string | any | What it is **built with**: `react`, `django`, `js`. Matches dependencies and topics, never the name. An unrecognised term matches nothing |
| `language` | string | any | Primary language, matched exactly (case-insensitively) |
| `labelled` | flag | off | Only issues with an invitation label |
| `max-setup` | `light` \| `moderate` \| `heavy` | any | Setup ceiling |
| `min-stars` | positive int | profile | Star floor |
| `max-stars` | positive int | profile | Star ceiling |
| `include-dormant` | flag | off | Include projects where nobody answers outside PRs |
| `org` | string | any | One organisation, matched against the owner (case-insensitively). The drill-down from `/api/orgs` |
| `exclude-claimed` | flag | off | Drop issues a claim check found taken. **Unchecked issues stay in** — see below |
| `momentum` | `hype` \| `rising` \| `steady` \| `cooling` | any | Growth crossed with review capacity. Excludes repositories whose velocity is unmeasured. Refused if it is none of these |
| `weights` | `default` \| `career-leverage` | from profile | Score against a named weight set for this request only |
| `fetch-limit` | positive int | 50000 | Rows fetched before ranking. See the `fetch-cap-hit` notice |

Flags accept `?labelled`, `?labelled=true`, `?labelled=1`, or an explicit `?labelled=false`.

`min-stars`, `max-stars` and `max-setup` fall back to your saved profile when not supplied. An explicit
value always wins, so a thin shortlist can be widened for one look without editing what is saved.

**Example**

```bash
curl 'http://127.0.0.1:8787/api/shortlist?limit=1&min-score=0'
```

```json
{
  "summary": {
    "considered": 15,
    "scoring": 15,
    "shown": 1,
    "total": 6,
    "offset": 0,
    "repos": 1,
    "minScore": 0,
    "perRepo": 2,
    "limit": 1,
    "scoreRange": { "min": 64, "max": 104, "median": 104 }
  },
  "rows": [
    {
      "rank": 1,
      "score": 104,
      "issue": {
        "issueId": 1009,
        "repoFullName": "hog/monopoly",
        "number": 100,
        "title": "Monopoly candidate 0",
        "htmlUrl": "https://github.com/hog/monopoly/issues/100",
        "labels": ["good first issue", "documentation"]
      },
      "evidence": [
        { "signal": "invited", "points": 16, "detail": "labelled \"good first issue\"", "about": "issue" },
        { "signal": "uncontested", "points": 6, "detail": "1 comment", "about": "issue" }
      ],
      "subtotals": { "repo": 82, "issue": 22 },
      "context": {
        "responsiveness": "responsive",
        "confidence": "high",
        "medianHoursResponse": 9,
        "noResponseRate": 0.07,
        "setupWeight": "light",
        "primaryLanguage": "TypeScript",
        "stars": 2600,
        "contributorAgreement": "dco"
      },
      "heldBackInRepo": 8,
      "pattern": {
        "repoFullName": "hog/monopoly",
        "declined": 3,
        "unlanded": 1,
        "repeatedReason": { "reason": "Needs design discussion first.", "count": 4 }
      }
    }
  ],
  "notices": []
}
```

**Reading `summary`**

| Field | Meaning |
|---|---|
| `considered` | Open, unassigned, unjudged issues that passed the SQL gates |
| `scoring` | Of those, how many met the score threshold |
| `total` | Rows available **after the per-repo cap**, across all pages. **Page against this, not `scoring`** |
| `shown` | Rows in this response |
| `offset` | Echo of the requested offset |
| `repos` | Distinct repositories on **this page** |
| `scoreRange` | Over the scoring set, not the shown set. `null` when nothing scored |

`total` and `scoring` differ for a real reason: the cap holds candidates back, so 400 scoring issues
concentrated in 30 repositories offer 60 pageable rows at a cap of two, not 400.

**Reading a row**

| Field | Meaning |
|---|---|
| `rank` | Absolute position in the capped list. Row 21 is `21` on page two, not `1` |
| `score` | No units. A sort key, nothing more |
| `evidence` | **Issue-level lines only**, capped at four. Repository lines are identical for every issue in a project |
| `subtotals` | Where the score came from, over **all** lines. `evidence` is capped so it cannot be summed to this |
| `context` | Repository facts as raw values. `null` means not measured, never zero |
| `heldBackInRepo` | Further scoring issues in this repository the cap held back |
| `pattern` | What your own journal says about this repository, or `null`. **Not part of the score** |

`context.contributorAgreement` is `cla`, `dco`, `both`, `none`, or `null` for unmeasured — and `null`
is not a stand-in for `none`. It is carried but never scored: whether a CLA is a blocker or an
irrelevance is a property of the person, not the project, and a weight would encode one of those as
universal.

`context.current` carries the facts that **decay**, and none of them is part of `score`:

| Field | Meaning |
|---|---|
| `claimVerdict` | `free` \| `claimed` \| `contested` \| `in-progress` \| `stale-claim`, or **`null` for never checked** |
| `claimAgeDays` | How old the verdict is. A `free` from three weeks ago is nearly worthless |
| `claimants` | How many distinct people asked |
| `quietDays` | Days since anything happened on the issue |
| `openPrTotal` | Every open pull request in the repository. Not the sampled `open_prs` |
| `oldestOpenPrDays` | How long the oldest open pull request has waited |
| `bounty` | Bounty labels, free from data already stored |
| `momentum` | `hype` \| `rising` \| `steady` \| `cooling`, or **`null` for unmeasured** |
| `momentumDetail` | The verdict with the numbers behind it, ready to display |
| `starsGained` / `velocitySpanDays` | Stars gained, and the span actually measured |

`momentum: null` means velocity could not be measured — fewer than two star samples a week or more apart —
and **not** that the repository is not growing. `hype` requires both a growth surge and a measured capacity
concern; growth alone never produces it.

**`claimVerdict: null` is not `free`.** It means nobody has looked. Rendering an unknown as available is
the specific error this data exists to prevent, so a client must show absence as absence.

`exclude-claimed` drops only what has been *checked and found taken* (`claimed`, `contested`,
`in-progress`). Unchecked issues remain, because they are not evidence of anything, and `stale-claim`
remains because a request nobody followed up on for a fortnight is an available issue again.

**Nothing in `current` is scored, deliberately.** A claim verdict exists only for issues somebody
checked, so scoring it would order two identical issues differently according to how requests had been
spent. And no weight in `weights.ts` has yet been validated against an outcome — adding six more
unvalidated numbers would make the ranking harder to trust rather than better.

`pattern` appears only when a repository has at least two negative outcomes in your journal.
`declined` counts issues you chose not to start; `unlanded` counts work that was abandoned, closed
unmerged, or stalled. `repeatedReason` is present only when a reason repeats, and quotes it verbatim in
the most recently written phrasing. Nothing here contributes to `score` — judged issues are gated out
of the shortlist entirely, so this describes the project rather than the candidate.

**Notices**

Structured rather than pre-worded, so each client writes its own remedy:

```json
{ "kind": "no-candidates" }
{ "kind": "none-scoring", "considered": 1204, "minScore": 20 }
{ "kind": "fetch-cap-hit", "fetchLimit": 50000 }
```

`fetch-cap-hit` matters: it means the ranking saw a recency-ordered subset rather than your corpus.
**Surface it.** Ignoring it makes a partial ranking look complete.

---

## Explaining one issue

### `GET /api/issues/:owner/:name/:number/why`

The full itemised breakdown. The reference is split across three path segments because
`owner/name#123` does not survive a single one intact.

```bash
curl 'http://127.0.0.1:8787/api/issues/acme/widgets/11/why'
```

```json
{
  "issue": {
    "issueId": 1001,
    "repoFullName": "acme/widgets",
    "number": 11,
    "title": "Fix off-by-one in the pagination helper",
    "htmlUrl": "https://github.com/acme/widgets/issues/11",
    "labels": ["good first issue", "bug"]
  },
  "score": 102,
  "repoLines": [
    { "signal": "responsiveness", "points": 22, "detail": "responsive, median 6h", "about": "repo" },
    { "signal": "merge rate", "points": 16, "detail": "85% of 21 decided outside PRs merged", "about": "repo" }
  ],
  "issueLines": [
    { "signal": "invited", "points": 16, "detail": "labelled \"good first issue\"", "about": "issue" }
  ],
  "repoSubtotal": 80,
  "issueSubtotal": 22,
  "unmeasured": ["setup"],
  "pattern": null
}
```

Lines are sorted by points descending within each group. `repoSubtotal + issueSubtotal === score`
always.

`unmeasured` lists signals that could not contribute because the underlying data is missing. These are
**absent, not zero** — an unmeasured project is not a bad one.

`pattern` is the same structure as on a shortlist row, scoped to this issue's repository. It sits
outside `repoSubtotal` and `issueSubtotal` by design, so the invariant above still holds.

Works on issues the shortlist rejected, which is most of the reason to call it.

**`404`** when the issue is not a current candidate — closed, assigned, already judged, or in a
repository that has not been synced:

```json
{
  "error": "not a current candidate",
  "detail": "acme/widgets#11 may be closed, assigned, already judged, or in a repo that is not synced."
}
```

---

## Recording decisions

### `POST /api/decisions`

```bash
curl -X POST http://127.0.0.1:8787/api/decisions \
  -H 'content-type: application/json' \
  -d '{"ref":"acme/widgets#11","verdict":"started","predictedHours":4,"reason":"looks self-contained"}'
```

| Field | Required | Meaning |
|---|---|---|
| `ref` | yes | `owner/name#123` |
| `verdict` | yes | One of the eight below |
| `predictedHours` | no | Positive number. Record when you **start** |
| `actualHours` | no | Positive number. Record when you **finish** |
| `reason` | no | Free text |

Verdicts: `shortlisted`, `rejected`, `started`, `abandoned`, `submitted`, `merged`, `closed_unmerged`,
`stalled`.

**`201`** on success, echoing what was stored:

```json
{
  "repoFullName": "acme/widgets",
  "number": 11,
  "title": "Fix off-by-one in the pagination helper",
  "verdict": "started",
  "predictedHours": 4,
  "actualHours": null,
  "reason": "looks self-contained"
}
```

Any verdict removes the issue from future shortlists. Post several over time for the same issue — they
accumulate into a trail, and a `predictedHours` followed later by an `actualHours` forms the pair the
calibration figure is built from.

---

## The journal

### `GET /api/journal`

| Parameter | Default | Meaning |
|---|---|---|
| `limit` | 30 | Issues to return |

```json
{
  "entries": [
    {
      "repoFullName": "acme/widgets",
      "number": 11,
      "title": "Fix off-by-one in the pagination helper",
      "trail": ["started", "merged"],
      "latestVerdict": "merged",
      "predictedHours": 4,
      "actualHours": 9,
      "ratio": 2.25,
      "reason": "looks self-contained",
      "lastAt": "2026-08-02T08:39:38.823Z"
    }
  ],
  "complete": 3,
  "meanRatio": 2.0833333333333335
}
```

Aggregated **per issue**, not per row: verdicts arrive as separate events over time, so a per-row view
could never pair a prediction with its outcome.

| Field | Meaning |
|---|---|
| `trail` | Verdicts in the order recorded |
| `ratio` | `actualHours / predictedHours`, only when both exist. `null` if `predictedHours` is 0 |
| `complete` | Entries with both a prediction and an outcome |
| `meanRatio` | **`null` below three complete pairs**, whatever the individual ratios say |

That threshold is enforced server-side on purpose. **Do not average the entries yourself** — an average
over one or two ratios is the false precision this tool refuses everywhere else. Show progress toward
three instead.

---

## Your profile

### `GET /api/profile`

```json
{
  "profile": {
    "languagePoints": { "Python": 22 },
    "topicPoints": { "etl": 9 },
    "avoidTopics": ["blockchain"],
    "avoidLabels": ["legacy"],
    "minStars": 500,
    "maxStars": 30000,
    "maxSetupWeight": "moderate"
  },
  "defaults": {
    "languagePoints": { "TypeScript": 14, "Python": 14, "Go": 8, "JavaScript": 6, "Java": 6, "Rust": 4 }
  },
  "maxPoints": 25
}
```

`defaults` is what an empty profile falls back to, so a settings screen can show it rather than imply
nothing is happening. `maxPoints` is the validation ceiling, so it can be explained before a user trips
it.

### `PUT /api/profile`

Whole-row replace, not a patch. Send the complete profile.

```bash
curl -X PUT http://127.0.0.1:8787/api/profile \
  -H 'content-type: application/json' \
  -d '{"languagePoints":{"Python":22},"topicPoints":{"etl":9},"avoidTopics":["blockchain"],"avoidLabels":[],"minStars":500,"maxStars":null,"maxSetupWeight":null}'
```

Every field is optional; omitted fields become empty.

Three rules the server enforces, each returning `400` with the reasoning:

- **Points are capped at ±25.** The largest measured weight is 22 (responsiveness). A preference that
  outranks every measurement turns the ranking into a filter, and there are already real filters.
- **Points must be whole numbers.** The breakdown prints them verbatim; a fractional line would imply
  precision the preference does not have.
- **Values are rejected, not coerced.** `"fourteen"` is an error. Reading it as 0 would quietly change
  every ranking with nothing appearing wrong.

**An empty `languagePoints` means the defaults apply.** A non-empty one **replaces them wholesale**
rather than merging — deleting a language must mean it stops scoring, not that it reverts to its
default.

---

## Languages

### `GET /api/stacks`

Frameworks detected in the corpus, with repository counts and display labels.

```json
{
  "stacks": [{ "stack": "react", "repos": 412 }, { "stack": "django", "repos": 88 }],
  "labels": { "react": "React", "django": "Django", "nextjs": "Next.js" }
}
```

Derived from declared dependencies plus GitHub topics, so it answers "what is this built with" rather
than "what is it called". `labels` is served so a client never invents a display name.

Empty until `sync setup` has run — the detection reads manifests that scan already fetches.

### `POST /api/repos`

Adds a project by name and makes it rankable.

```bash
curl -X POST http://127.0.0.1:8787/api/repos \
  -H 'content-type: application/json' -d '{"ref":"django/django"}'
```

| Field | Required | Meaning |
|---|---|---|
| `ref` | yes | `owner/name`, or a pasted GitHub URL |
| `metadataOnly` | no | Skip the issue, metric and setup scans that normally follow |

**`202 Accepted`** — the row is written first, then its issues, metrics and setup are scanned in the
background, so it is not yet rankable when this responds:

```json
{ "started": { "kind": "repos", "startedAt": "2026-08-03T09:14:02.001Z", "options": {}, "adding": "django/django" } }
```

Poll `GET /api/sync` to watch it finish; `active.adding` names the project. A failure appears as
`lastAddError`, because a failed add leaves nothing useful in `sync_runs` — that row only records that a
`repos` run happened, not that a particular project could not be found.

`404` if GitHub has no such public repository. `400` for a malformed reference. `409` if a scan is
already running.

### `POST /api/issues/:owner/:name/:number/claims`

Is this issue actually free? Reads the comment thread and returns a dated verdict.

**POST rather than GET**, because it spends a request against the GitHub rate limit and writes a row. A
GET that a browser or a prefetcher could fire on its own would drain the budget answering questions
nobody asked; this has to be something the person chose to do.

**Query parameters**

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `cached` | flag | off | Return an earlier verdict without fetching |

**Example**

```json
{
  "issueId": 1010,
  "repoFullName": "hog/monopoly",
  "number": 101,
  "title": "Monopoly candidate 1",
  "htmlUrl": "https://github.com/hog/monopoly/issues/101",
  "checkedAt": "2026-08-04T09:12:00.000Z",
  "verdict": "contested",
  "claimants": 7,
  "claims": [
    { "author": "ada", "at": "2026-08-01T…", "why": "asked to take it", "excerpt": "Can I work on this?" }
  ],
  "progress": [],
  "linkedPrs": [],
  "bountyHint": null,
  "bountyLabels": [],
  "commentsRead": 41,
  "commentsTotal": 41,
  "fromCache": false
}
```

`verdict` in order of authority:

| Verdict | Meaning | What to do |
|---|---|---|
| `in-progress` | Somebody reported actual work, or a pull request is linked | Skip it. A second pull request helps nobody |
| `contested` | Several people asked and nobody was assigned | The evening-waster. Unless you want to race, go elsewhere |
| `claimed` | One recent request, nobody assigned | Comment before you start |
| `stale-claim` | A request went quiet for longer than an intention survives | Probably yours. Say so in the thread |
| `free` | Nobody asked | Nothing suggests anyone else is on it |

`commentsRead` and `commentsTotal` are both returned so coverage is visible: a verdict from 100 comments
of a 412-comment thread is a weaker claim than one that read everything, and only the caller can decide
what to say about the gap.

Requires `GITHUB_TOKEN` — but only when the issue actually has comments. A thread with none is answered
from the corpus without touching the network.

404 when the issue is not in the corpus.

### `GET /api/orgs`

The organisation table: which organisations are worth your time, before the question of which issue.

Every measured value is a rollup over the organisation's repositories, computed on read. Nothing is
stored, so a rollup can never disagree with the metrics it summarises.

**Query parameters** — all optional:

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `sort` | `attention` \| `candidates` \| `name` | `attention` | Ordering. An unknown value is refused |
| `momentum` | `hype` \| `rising` \| `steady` \| `cooling` | any | The organisation's modal momentum verdict |
| `gsoc` | four-digit year \| `any` | any | Only organisations tagged as GSoC participants. Refused if it is neither |
| `language` | string | any | Modal primary language, matched case-insensitively |
| `min-repos` | positive int | any | Drop organisations with fewer repositories in the corpus |
| `uncovered` | flag | off | Only organisations with **no** repositories in the corpus |
| `limit` | positive int | 50 | Rows per page |
| `offset` | int ≥ 0 | 0 | Rows to skip |

**Example**

```json
{
  "summary": {
    "organizations": 6,
    "shown": 2,
    "uncovered": 3,
    "unmeasured": 0,
    "openCandidates": 11
  },
  "rows": [
    {
      "login": "hog",
      "displayName": null,
      "repos": 1,
      "measuredRepos": 1,
      "responsiveness": "responsive",
      "agreeing": 1,
      "medianRepoHoursResponse": 9,
      "mergeRate": 0.857,
      "decidedPrs": 14,
      "setup": { "light": 1, "moderate": 0, "heavy": 0, "unknown": 0 },
      "claRepos": 0,
      "dcoRepos": 1,
      "stars": 2600,
      "primaryLanguage": "TypeScript",
      "openCandidates": 6,
      "candidateRepos": 1,
      "momentum": "hype",
      "momentumRepos": 1,
      "starsGained": 1400,
      "gsocYears": [2026],
      "tagsReviewedAt": "2026-08-04"
    }
  ],
  "gsoc": {
    "year": 2026,
    "phase": "coding",
    "daysUntil": 19,
    "estimated": false,
    "message": "GSoC 2026 coding is under way. …"
  },
  "notices": ["3 organisation(s) here have no repositories in your corpus. …"]
}
```

**How each value is combined**, because none of these is an average of a score:

| Field | Combination | Why |
|---|---|---|
| `responsiveness` | The **modal** verdict across measured repositories, ties broken toward the worse one | One dormant repo out of forty does not make an organisation dormant, and one responsive repo out of forty does not make it responsive. A tie resolves pessimistically because being told an organisation replies when half of it does not costs an evening |
| `agreeing` / `measuredRepos` | The denominator behind that verdict | `2 of 4` is a different claim from `9 of 9`, and the reader gets to discount it |
| `medianRepoHoursResponse` | Median of the **per-repository** medians | This is the typical *repository*, not the typical pull request. The field is named to keep that from being forgotten |
| `mergeRate` / `decidedPrs` | **Pooled**: total merged over total decided | Not the mean of per-repo rates, which would let a repository with two decided PRs outvote one with two hundred. `100%` of 2 and `74%` of 300 must be distinguishable |
| `setup` | A **distribution**, never an average | `light`/`moderate`/`heavy` are ordinals. Averaging them would invent a number, which is the one thing this tool does not do. It sums to fewer than `repos` when some have not been read |
| `momentum` | The **modal** momentum verdict across repositories where velocity is measured, ties broken toward the worse one | `hype` is the expensive thing to be wrong about, as with responsiveness |
| `starsGained` | Summed across repositories, and labelled as a sum | Adding growth is meaningful in a way adding verdicts would not be, but it is still scale rather than quality |
| `gsocYears`, `tagsReviewedAt` | Curated, with the **oldest** review date of any tag | Curated is not measured. The oldest date is reported because the reader is about to trust every claim at once |

`responsiveness: null` means nothing here has been measured. It is **not** the verdict `unknown`, which
is a measured outcome meaning the evidence was too thin to call.

`repos: 0` is a real row, not an empty one: an organisation from a curated list that has never been
measured is the answer to "which of these have I never looked at". Drill in with
`/api/shortlist?org=<login>`.

`gsoc.estimated` is true whenever the driving date was inferred from 2026 rather than published. Only
2026's timeline exists; every later year is a planning assumption.

### `GET /api/languages`

Languages present in the corpus, with GitHub's canonical casing and repository counts, most common
first. Paused repositories are excluded.

```json
{ "languages": [ { "language": "TypeScript", "repos": 412 }, { "language": "Python", "repos": 388 } ] }
```

Exists so a client can offer a list instead of a text box. Typing a language was the one place where
getting the casing wrong returned an empty result that looked like a real answer.

---

## The corpus and syncing

### `GET /api/sync`

Everything needed to render a sync screen.

```json
{
  "kinds": ["seed", "repos", "issues", "metrics", "setup"],
  "nextStep": { "kind": "metrics", "because": "No project has been measured for maintainer attention yet, which is the signal that matters most." },
  "lastAddError": null,
  "active": { "kind": "repos", "startedAt": "2026-08-02T08:39:38.823Z", "options": { "limit": 3 } },
  "runningElsewhere": [],
  "tokenConfigured": true,
  "corpus": {
    "repos": 1076,
    "pausedRepos": 193,
    "issues": 85961,
    "openIssues": 41203,
    "reposWithMetrics": 1072,
    "reposWithSetup": 1072,
    "staleMetadata": 312,
    "decisions": 8
  },
  "runs": [
    {
      "runId": 42,
      "kind": "repos",
      "status": "ok",
      "startedAt": "2026-08-02T08:39:38.823Z",
      "finishedAt": "2026-08-02T08:52:11.004Z",
      "reposSeen": 1000,
      "reposUpserted": 41,
      "issuesUpserted": 0,
      "requests": 1000,
      "notModified": 959,
      "error": null
    }
  ]
}
```

`nextStep` is the pipeline expressed as one instruction, derived from what the corpus is missing. Its
`kind` is a scan name, or `ready` when nothing needs scanning. **Render it** — five buttons with no
indication that four of them must run in order is a screen a newcomer cannot act on.

`active` is what **this server process** is running. When it carries `adding`, the job is an
`add` rather than a corpus-wide scan. `runningElsewhere` lists rows the database still
calls `running`, which means either a CLI run in another terminal or a process that died mid-run — the
server genuinely cannot tell which, and says so rather than guessing.

Run statuses: `running`, `ok`, `failed`, `aborted_budget`. **`aborted_budget` is not a failure** — the
run stopped before exhausting your GitHub allowance, and watermarks make it resume cleanly.

### `POST /api/sync/:kind`

Starts a scan. `:kind` is one of `seed`, `repos`, `issues`, `metrics`, `setup`.

```bash
curl -X POST http://127.0.0.1:8787/api/sync/repos \
  -H 'content-type: application/json' -d '{"limit":500,"staleHours":24}'
```

| Field | Applies to | Meaning |
|---|---|---|
| `limit` | all | Repositories to process. For `seed`, pages per search |
| `repo` | all but `seed` | `owner/name`, one repository only |
| `staleHours` | `repos` | Skip repositories refreshed more recently |
| `staleDays` | `metrics`, `setup` | Skip repositories measured more recently |

**`202 Accepted`** — the scan is *under way*, not finished:

```json
{ "started": { "kind": "repos", "startedAt": "2026-08-02T08:39:38.823Z", "options": { "limit": 500 } } }
```

Poll `GET /api/sync` for progress. Counters flush every three seconds while a run is in flight.

Three constraints, each deliberate:

- **`409 Conflict` if one is already running.** Scans share one hourly GitHub budget, and `repos` would
  write the same rows twice. The guard is in-process, so it cannot see a CLI run elsewhere — hence
  `runningElsewhere`.
- **No cancellation endpoint.** Nothing here can interrupt an HTTP request already in flight, and
  offering a stop button that does not stop things would be a lie. Budget exhaustion ends a run
  cleanly and it resumes next time.
- **`503` if no `GITHUB_TOKEN` is configured**, checked before starting so a missing token is an
  actionable message rather than a failed run in your history.

---

## Utility

### `GET /api/health`

```json
{ "ok": true }
```

### `GET /api/verdicts`

```json
{ "verdicts": ["shortlisted", "rejected", "started", "abandoned", "submitted", "merged", "closed_unmerged", "stalled"] }
```

Served so clients do not keep their own copy of the vocabulary.

---

## Errors

Every error is JSON with an `error` field carrying a message written for a person.

| Status | Means |
|---|---|
| `400` | Bad input — unknown verdict, malformed reference, out-of-range points, non-numeric parameter |
| `404` | No such route, or the issue is not a current candidate |
| `409` | A sync is already running in this server |
| `500` | A real server fault. The message is deliberately not on the wire; check the server log |
| `503` | The server is fine but not configured to reach GitHub |

```json
{ "error": "languagePoints[\"Rust\"] is 99; keep preferences within ±25 so they rank candidates rather than override the measured signals. Use the filters to exclude." }
```

**Bad input is refused, not coerced.** `?limit=banana` and `?limit=-1` are both `400`. A parameter
quietly ignored would produce a plausible-looking answer to a question you did not ask.

An unknown path under `/api/` returns a JSON `404` rather than the app's HTML, so a mistyped endpoint
fails where the mistake is rather than as a parse error several layers away.
