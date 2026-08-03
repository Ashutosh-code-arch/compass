# Configuration

All configuration is environment variables, read from `.env` in the repository root at startup.

```bash
cp .env.example .env
```

`.env` is in `.gitignore`. Never commit it — it contains your GitHub token.

Variables can also be set in your shell, which takes precedence and is useful for one-off runs:

```bash
DATABASE_URL=postgres://localhost/compass_test npm test
```

---

## Required

### `DATABASE_URL`

The Postgres connection string. **The only variable needed to read your corpus.**

```ini
DATABASE_URL=postgres://localhost:5432/compass
```

| Situation | Value |
|---|---|
| Homebrew on macOS | `postgres://localhost:5432/compass` |
| Ubuntu / Debian default | `postgres://postgres@localhost:5432/compass` |
| With a password | `postgres://user:password@localhost:5432/compass` |
| Docker | `postgres://postgres:compass@localhost:5432/compass` |
| Remote, requiring TLS | `postgres://user:pass@host:5432/compass?sslmode=require` |

If the password contains `@`, `:`, `/` or `?`, percent-encode it.

Missing this fails immediately with `Missing DATABASE_URL`.

---

## Needed only for fetching data

### `GITHUB_TOKEN`

A GitHub personal access token. **Not required to read an existing corpus** — `migrate`, `shortlist`,
`why`, `journal`, the API and the whole web interface work without one. Only the `seed` and `sync`
commands need it.

```ini
GITHUB_TOKEN=github_pat_...
```

Create one at <https://github.com/settings/personal-access-tokens/new> with **Public repositories
(read-only)** and nothing else.

> **Grant no write, workflow, or organisation permissions.** Compass only ever reads public data. A
> token that can write to your repositories is a token that can damage them if it leaks.

Without it, `GET /api/sync` reports `tokenConfigured: false` and the sync screen explains what to do,
rather than the server refusing to start.

---

## Tuning the GitHub client

Sensible defaults; change them only if you have a reason.

### `GITHUB_MIN_REMAINING`

Default `300`. Stop a run rather than spend the last of the hourly quota.

```ini
GITHUB_MIN_REMAINING=300
```

Watermarks make aborts resumable, so a conservative floor costs you nothing but a second run. A run that
stops here is recorded as `aborted_budget`, which is **not** a failure.

Set it lower only if Compass is the only thing using the token. Set it higher if you share the token with
CI or another tool.

### `SYNC_CONCURRENCY`

Default `3`. In-flight requests. GitHub asks for modest concurrency from a single token, and 3 is polite
and fast enough. Raising this risks secondary rate limits, which are undocumented and unpleasant.

### `SYNC_MIN_INTERVAL_MS`

Default `120`. Courtesy floor between request starts, in milliseconds. Guards the same undocumented
secondary limits.

### `GITHUB_USER_AGENT`

Default `opensource-compass/0.1 (personal)`. GitHub asks that clients identify themselves.

---

## Correcting the measurements

### `COMPASS_IGNORE_LOGINS`

Comma-separated logins to treat as bots, case-insensitive.

```ini
COMPASS_IGNORE_LOGINS=my-ci-bot,triage-helper,klembot
```

**This one materially changes your numbers, and it is worth using.** An automated first-responder that
posts "thanks for your contribution!" on every pull request both flatters the median response time and
hides the true ignore rate — the queue looks attended when nothing has actually been read.

Find them with:

```bash
npm run compass -- responders --limit 30
```

Any account with dozens of responses at a near-zero median is automation. Add it here, then recompute:

```bash
npm run compass -- sync metrics --stale-days 0
```

Note that detecting bots by a `bot` name suffix does not work — it misclassifies real people, such as
the human login `klembot`. Hence the manual list.

---

## The server

### `COMPASS_HOST`

Default `127.0.0.1`.

```ini
COMPASS_HOST=127.0.0.1
```

> **Think before changing this.** There is no authentication, and `POST /api/decisions` and
> `PUT /api/profile` write to your database. Binding `0.0.0.0` puts an unauthenticated write endpoint on
> your network. If you need remote access, use an SSH tunnel:
>
> ```bash
> ssh -L 8787:127.0.0.1:8787 you@your-machine
> ```

### `COMPASS_PORT`

Default `8787`. Overridden by `--port`.

### `COMPASS_DEBUG`

Unset by default. Set to any value for verbose request logging when diagnosing a sync.

---

## A complete example

```ini
# --- required ---------------------------------------------------------------
DATABASE_URL=postgres://localhost:5432/compass

# --- needed only for fetching data ------------------------------------------
GITHUB_TOKEN=github_pat_your_token_here

# --- GitHub client ----------------------------------------------------------
GITHUB_MIN_REMAINING=300
SYNC_CONCURRENCY=3
SYNC_MIN_INTERVAL_MS=120

# --- measurement corrections ------------------------------------------------
# Bot first-responders found via `npm run compass -- responders`
COMPASS_IGNORE_LOGINS=

# --- server -----------------------------------------------------------------
COMPASS_HOST=127.0.0.1
COMPASS_PORT=8787
```

---

## Where configuration is read

`src/config.ts`, once, cached. `DATABASE_URL` is required at load; `GITHUB_TOKEN` is checked by
`requireGitHubToken()` in the REST and GraphQL clients, at the point a network call is actually made.

That split is deliberate: demanding a token up front meant a database restored onto a machine without
one could not even be queried, and it made the "no token configured" screen unreachable because the
server died before it could render it.
