# Troubleshooting

Start here:

```bash
npm run status
```

It prints corpus counts, recent runs, and budget usage. Most problems are visible in that output.

---

## Setup and connection

### `Missing DATABASE_URL`

`.env` is missing, or not in the repository root. It belongs next to `package.json`.

```bash
ls -la .env          # is it there?
cp .env.example .env # if not
```

A shell variable also works, and takes precedence:

```bash
DATABASE_URL=postgres://localhost/compass npm run status
```

### `ECONNREFUSED 127.0.0.1:5432`

Postgres is not running.

```bash
brew services start postgresql@16     # macOS
sudo systemctl start postgresql       # Linux
docker start compass-db               # Docker
```

Confirm with `pg_isready`.

### `database "compass" does not exist`

```bash
createdb compass
npm run migrate
```

### `password authentication failed for user`

Your `DATABASE_URL` credentials are wrong. On a default Ubuntu install the user is `postgres`, not your
own username:

```ini
DATABASE_URL=postgres://postgres@localhost:5432/compass
```

If the password contains `@`, `:`, `/` or `?`, percent-encode it.

### `relation "repos" does not exist`

Migrations have not run.

```bash
npm run migrate
```

### `Cannot find module` or a syntax error on startup

Node is too old. Compass runs TypeScript directly, which needs 22.18 or newer.

```bash
node --version
```

---

## Empty results

### The shortlist is empty

Work down this list:

```bash
npm run compass -- shortlist --min-score 0      # 1. lower the bar
npm run status                                   # 2. is there any data?
```

If `--min-score 0` shows rows, your corpus has nothing strong — sync more projects.

If it is still empty and `status` shows zero issues, run the four steps in
[Getting started](getting-started.md).

If `status` shows issues but the shortlist is empty even at `--min-score 0`, everything is being gated
out. The gates are: closed, assigned, locked, already judged, or in a dormant project. Try:

```bash
npm run compass -- shortlist --min-score 0 --include-dormant
```

If *that* produces rows, your measured projects are all dormant — nobody answers outside pull requests.
That is a real finding, not a bug. Widen your corpus.

### Every project shows `responsiveness not measured`

You have not run `sync metrics`. That is the step that makes the ranking meaningful.

```bash
npm run compass -- sync metrics --limit 100
```

### Everything shows `setup not measured`

Same, for setup:

```bash
npm run compass -- sync setup --limit 100
```

### The language filter returns nothing

It is case-insensitive now, so `python` and `Python` both work. If a language genuinely returns nothing,
check what your corpus actually contains:

```bash
curl -s localhost:8787/api/languages | head -20
```

The web interface uses a dropdown fed from that list, which is the reliable way to pick.

### Confidence is `low` or `none` everywhere

Too few external pull requests to judge. Either your corpus skews toward small projects, or `--pr-count`
is too low. This is unmeasured, not bad — Compass halves repository signals on thin samples rather than
pretending to know.

---

## GitHub and syncing

### `Missing GITHUB_TOKEN`

Only fetching needs a token. Add it to `.env` and restart.

```ini
GITHUB_TOKEN=github_pat_...
```

Reading an existing corpus — `shortlist`, `why`, `journal`, the API, the web interface — needs no token
at all.

### `GitHub 401: Bad credentials`

The token is wrong, expired, or has a stray space or newline. Generate a fresh one at
<https://github.com/settings/personal-access-tokens/new> with **Public repositories (read-only)**.

Check what the token is actually being sent as:

```bash
node -e "console.log(JSON.stringify(process.env.GITHUB_TOKEN))" 
```

Quotes around the value in `.env` become part of the value. Do not quote it.

### `GitHub 403` with a rate-limit message

You are out of hourly quota. It resets on the hour.

```bash
npm run status    # shows remaining budget
```

### A sync stopped early saying the budget is low

**Working as intended.** Compass stops before exhausting your allowance rather than failing mid-run. The
run is recorded as `aborted_budget`, which is *not* a failure — watermarks only advance for repositories
that completed, so the next run resumes without a gap.

Wait for the hour to turn and run it again.

### A sync is slow

Expected. Fetching a thousand projects fully takes a while, and Compass deliberately keeps concurrency low
(3 in flight, 120ms apart) to stay inside GitHub's undocumented secondary limits. Raising
`SYNC_CONCURRENCY` risks tripping them, which is worse than slow.

Use `--limit` to work in batches.

### `TypeError: terminated` during a sync

Undici aborting a response body stream. Handled by the retry logic; if it happens repeatedly your network
is dropping connections. Re-run — syncs resume.

### `sync repos` does not cover my whole corpus

It defaults to `--limit 1000`. Above a thousand repositories, run it twice.

### Response times look implausibly fast, or the ignore rate looks too low

A bot is answering pull requests. An automated first-responder that comments on everything both flatters
the median and hides the true ignore rate.

```bash
npm run compass -- responders --limit 30
```

Any account with dozens of responses at a near-zero median is automation. Add it to
`COMPASS_IGNORE_LOGINS` in `.env`, then recompute:

```bash
npm run compass -- sync metrics --stale-days 0
```

Note that detecting bots by a `bot` name suffix does not work — it misclassifies real people, such as the
human login `klembot`. Hence the manual list.

---

## The web interface

### "Cannot reach the API"

The server is not running.

```bash
npm start
```

### The page is blank, or 404 at the root

The frontend has not been built.

```bash
npm run web:build && npm run serve
```

Or `npm start`, which does both.

### `EADDRINUSE: address already in use`

Something is on port 8787 — probably an older Compass.

```bash
lsof -i :8787              # find it
npm run compass -- serve --port 8788
```

### Changes to the frontend do not appear

You are looking at the built copy. For hot reload, run two processes and use `:5173`:

```bash
npm run serve      # terminal 1
npm run web:dev    # terminal 2
```

For the built copy, rebuild: `npm run web:build`.

### "A repos sync is already running" but nothing is

One of two things.

If the *server* thinks it is running, restart the server — the lock is in-process.

If the **corpus** screen shows runs under "still marked as running", a previous process was killed before
it could record how it ended. Compass cannot tell that apart from a live CLI run, so it reports it without
guessing. Clear them by hand if you are sure nothing is going:

```sql
update sync_runs set status = 'failed', finished_at = now(),
       error = 'process died before recording an outcome'
where status = 'running' and started_at < now() - interval '6 hours';
```

### A sync started from the UI is not progressing

Counters flush every three seconds. If they are genuinely static, check the server log — the run may have
failed, and the failure is recorded in `sync_runs` with the reason.

---

## Results that look wrong

### A project I know is complicated reads as `light` setup

Almost certainly the known limitation: **setup is read from root-level files only.** A compose file in
`build/` or an env template in `config/` is invisible.

`mattermost/mattermost` reads as `light`. It is not. See [Roadmap](roadmap.md).

### An issue I would never pick is ranked first

Use `why` on it. Usually one of:

- **A stale measurement.** Recompute: `sync metrics --repo owner/name --stale-days 0`
- **A weight you disagree with.** It is in `src/rank/weights.ts`. Change it
- **The score is mostly the project.** Check the provenance split — if it is 80/20 project, the tool is
  recommending the repository, not the task

### Suspiciously many trivial issues from one project

An issue mill: repositories auto-generating labelled tasks so contributors can farm activity counts.
There is a −35 penalty for the pattern, triggered at 8 or more invitation-labelled issues within 7 days.

If it slipped through, lower the threshold in `weights.ts`, or just:

```bash
npm run compass -- decide owner/name#123 rejected --reason "issue mill"
```

### The calibration figure will not appear

It needs **three** issues with both a prediction and an outcome, and the server sends `null` until then.
Deliberate — an average over one or two ratios is exactly the false precision the tool refuses elsewhere.

```bash
npm run compass -- journal    # shows how many complete pairs you have
```

Both numbers must be on the same issue: `--hours` when you start, `--actual-hours` when you finish.

### A shortlist warns it ranked a subset

The `fetch-cap-hit` notice. Your corpus is large enough to hit the row cap before ranking, so the ranking
saw whichever issues were updated most recently rather than all of them.

**Do not ignore this** — the ranking is not trustworthy while it shows. Narrow the filters, or raise
`--fetch-limit`.

---

## Still stuck

```bash
npm test           # is the code itself healthy?
npm run typecheck
npm run status     # what does it think it has?
COMPASS_DEBUG=1 npm run compass -- sync metrics --limit 1   # verbose
```

To test against known-good data and rule out your corpus entirely:

```bash
createdb compass_dev
DATABASE_URL=postgres://localhost/compass_dev npm run migrate
psql compass_dev -f fixtures/dev_corpus.sql
DATABASE_URL=postgres://localhost/compass_dev npm run compass -- shortlist --min-score 0
```

If the fixture corpus produces a sensible shortlist, the code is fine and the problem is in your data.
