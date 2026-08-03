# Compass

**Finds open-source issues that are actually worth your time.**

Searching GitHub for `label:"good first issue"` gives you thousands of results and no way to tell them
apart. Most are traps. The project has been abandoned. The maintainers never reply to outsiders.
Getting it running locally takes a weekend. Someone else is already working on it without saying so.

Compass measures those things ahead of time and ranks issues by whether they are worth five hours of
your evening. Then it shows you exactly why it ranked each one that way, so you can disagree with it.

Here is one row of the output:

```
 01. [104]  acme/widgets#11  Fix off-by-one in the pagination helper
      the project +82   this issue +22
      +16 invited (labelled "good first issue")  +6 uncontested (1 comment)
      responsive · median reply 6h · light setup · TypeScript · 4,200 stars
```

That says: the maintainers reply to outside pull requests within about six hours, the project is quick
to set up, the issue invites contributors, and nobody else is arguing about it. It also says **82 of
the 104 points came from the project, not the issue** — so this is really a recommendation of
`acme/widgets`, and any of its issues would do.

There is a web interface for all of this, and a command line if you prefer.

---

## Contents

- [What it actually measures](#what-it-actually-measures)
- [What you need first](#what-you-need-first)
- [Setup, step by step](#setup-step-by-step)
- [Your first run](#your-first-run)
- [Using it](#using-it)
- [Reading the output](#reading-the-output)
- [Common problems](#common-problems)
- [Full documentation](#full-documentation)

---

## What it actually measures

Four things, all from public GitHub data. No AI, no language model, no guessing.

| | Question | How |
|---|---|---|
| **Maintainer attention** | Do they review pull requests from strangers, how fast, and do they merge them? | Reads the last 180 days of external pull requests |
| **Setup cost** | How much work before you can run the tests? | Reads compose files, env templates, task runners, CI config |
| **Issue signals** | Is this issue inviting, specified, and unclaimed? | Labels, body length, comment count, age, who filed it |
| **Your preferences** | Languages and subjects you want, and things to avoid | You set these in the app |

Two of those are measurements. Two are opinions. **The tool is careful about which is which**, and so
should you be — see [How ranking works](docs/how-ranking-works.md).

---

## What you need first

Three things. If you already have them, skip to [Setup](#setup-step-by-step).

### 1. Node.js, version 22.18 or newer

Compass runs TypeScript directly, which needs a recent Node.

Check what you have:

```bash
node --version
```

If that prints `v22.18.0` or higher you are fine. If it prints something lower, or
`command not found`, install it:

- **macOS** — `brew install node`
- **Windows** — download the LTS installer from [nodejs.org](https://nodejs.org)
- **Ubuntu / Debian** — `sudo apt install nodejs npm`; if that gives you an older version, use
  [NodeSource](https://github.com/nodesource/distributions)
- **Any system** — [nvm](https://github.com/nvm-sh/nvm) is the least painful way to manage versions:
  `nvm install 22 && nvm use 22`

### 2. PostgreSQL, version 14 or newer

This is the database where Compass keeps everything it has learned. Tested on Postgres 16.

```bash
psql --version
```

If it is missing:

- **macOS** — `brew install postgresql@16 && brew services start postgresql@16`
- **Windows** — the installer from [postgresql.org](https://www.postgresql.org/download/windows/)
- **Ubuntu / Debian** — `sudo apt install postgresql && sudo systemctl start postgresql`
- **Docker**, if you would rather not install it —
  `docker run -d --name compass-db -e POSTGRES_PASSWORD=compass -p 5432:5432 postgres:16`

### 3. A GitHub token

Compass reads public GitHub data. Without a token you get 60 requests an hour, which is not enough;
with one you get 5,000.

**Only needed for fetching data.** Reading a database you already have needs no token at all.

To create one:

1. Go to <https://github.com/settings/personal-access-tokens/new>
2. Give it a name like `compass`
3. Under **Repository access**, choose **Public repositories (read-only)**
4. Leave every other permission alone
5. Click **Generate token** and copy it — you cannot see it again

> **Do not grant write, workflow, or organisation permissions.** Compass only ever reads public data.
> A token that can write to your repositories is a token that can damage them if it leaks.

---

## Setup, step by step

### Step 1 — Get the code and install dependencies

```bash
git clone https://github.com/Ashutosh-code-arch/compass.git
cd compass

npm install          # the backend and CLI
npm run web:install  # the web interface
```

### Step 2 — Create the database

```bash
createdb compass
```

If `createdb` is not found, or you are using Docker, do it through `psql` instead:

```bash
psql -U postgres -c "CREATE DATABASE compass;"
```

### Step 3 — Write your configuration file

```bash
cp .env.example .env
```

Open `.env` in any text editor. You need to set two lines:

```ini
DATABASE_URL=postgres://localhost:5432/compass
GITHUB_TOKEN=github_pat_paste_yours_here
```

`DATABASE_URL` depends on how you installed Postgres:

| How you installed it | Use this |
|---|---|
| Homebrew on macOS | `postgres://localhost:5432/compass` |
| Ubuntu / Debian default | `postgres://postgres@localhost:5432/compass` |
| Docker, from the command above | `postgres://postgres:compass@localhost:5432/compass` |
| With a password | `postgres://user:password@localhost:5432/compass` |

> `.env` is already in `.gitignore`. Never commit it.

### Step 4 — Create the database tables

```bash
npm run migrate
```

You should see:

```
applied 001_init.sql
applied 002_maintainer_metrics.sql
...
applied 008_stacks_and_full_tree.sql
```

Run it again and it will say `Up to date (8 migration(s) applied).` — it is safe to run any number of
times.

### Step 5 — Start the app

```bash
npm start
```

This builds the web interface and starts the server. When it is ready:

```
Compass listening on http://127.0.0.1:8787
  the app is at http://127.0.0.1:8787/
```

Open <http://127.0.0.1:8787> in your browser.

**The shortlist will be empty, and that is correct.** You have a database but no data in it yet.

---

## Your first run

Compass needs to build up a picture of some projects before it can rank anything. Do this from the
**The corpus** tab in the app, or from the command line — they do exactly the same work.

The four steps must run in this order, because each one needs the previous one.

### 1. Find some projects

```bash
npm run compass -- seed
```

Runs a set of searches to discover repositories worth looking at. Takes a couple of minutes and adds
roughly a thousand projects.

### 2. Pull their issues

```bash
npm run compass -- sync issues --limit 100
```

The `--limit 100` does the first hundred projects only. Start small — this is the slowest step, and
you want to see it working before committing an hour to it. Drop the limit once you trust it.

### 3. Measure whether maintainers reply

```bash
npm run compass -- sync metrics --limit 100
```

**This is the step that makes Compass worth using.** It reads the last 180 days of pull requests from
outside contributors and works out whether anyone reviews them, how quickly, and how often they get
merged.

### 4. Measure setup cost

```bash
npm run compass -- sync setup --limit 100
```

Reads each project's compose files, env templates, task runner and CI config to judge how much work
it is to get running.

### Or skip all that and add a project you already care about

```bash
npm run compass -- add django/django
```

This fetches the project, pulls its issues, measures its maintainers and reads its setup cost — one
command, ready to rank. Useful when you have a specific project in mind rather than wanting to browse.
A project added this way is never paused by pruning.

### Then look at your shortlist

Reload the app, or:

```bash
npm run compass -- shortlist
```

If nothing appears, run `npm run compass -- shortlist --min-score 0` to see everything including the
weak candidates. An empty list at the default threshold usually means metrics have not been collected
yet.

> **A note on timing.** Fetching 1,000 projects fully takes a while and spends most of an hourly
> GitHub allowance. Compass stops itself before exhausting your quota and picks up where it left off
> next time, so it is safe to run repeatedly. The `--limit` flag is your friend while you are getting
> a feel for it.

---

## Using it

### The web interface

Four tabs:

| Tab | What it is for |
|---|---|
| **Shortlist** | The ranked issues. Filter on the left, click any row for its full score breakdown. |
| **What you decided** | Every issue you judged, and how your time estimates compared to reality. |
| **What you want** | Your languages, subjects, things to avoid, and a star range. Changing these re-ranks everything. |
| **The corpus** | What data you have, buttons to fetch more, a field to add a project by name, and a banner saying which scan to run next. |

### The normal loop

1. Open the **Shortlist**
2. Click a row and read the breakdown — decide whether you believe it
3. Open the issue on GitHub if it looks good
4. Click **Record a decision**, choose `started`, and put in **how many hours you think it will take**
5. When you finish, record `merged` (or `abandoned`, or whatever happened) with **how long it actually
   took**

Step 5 is the one people skip, and it is the one that matters. After three of those pairs, the **What
you decided** tab starts telling you how far off your estimates run. After about fifteen, the scoring
weights stop being guesses.

### The command line

Everything the app does, plus some reports the app does not have yet:

```bash
npm run compass -- add django/django
npm run compass -- shortlist --stack react
npm run compass -- shortlist --language Python --max-setup light
npm run compass -- why owner/name#123
npm run compass -- decide owner/name#123 started --hours 4
npm run compass -- decide owner/name#123 merged --actual-hours 9
npm run compass -- journal
npm run compass -- status
```

Full list: `npm run compass -- --help`, or the [CLI reference](docs/cli-reference.md).

---

## Reading the output

The score has **no units and predicts nothing.** It only puts candidates in order. A 104 is not "twice
as good" as a 52, and it does not mean 104 of anything.

What to actually read:

**The provenance bar** — `the project +82   this issue +22`. If nearly all the points came from the
project, the tool is recommending the *repository*, and any of its issues would serve. If a decent
share came from the issue, this particular issue stood out.

**The evidence lines** — `+16 invited (labelled "good first issue")`. Every line carries the raw fact
behind it. This is the part to trust; the total is just a sort key.

**The stepped meters** — `responsive`, `light setup`. These are buckets, not percentages, which is why
they are drawn as discrete cells rather than bars. More lit cells means more of the thing; the colour
says whether more is good (attention) or costly (setup).

**"Built with" is not a name match.** Filtering by `react` reads declared dependencies and GitHub
topics, so a project called `awesome-react-tips` will not match and one that quietly depends on React
will. `js` covers JavaScript *and* TypeScript; `--language JavaScript` is the strict form.

**A dash means not measured.** `median reply —` means Compass has no data, **not** that the reply time
is zero. Unmeasured is never treated as bad.

Click **Show the full breakdown** for every line, split into "the project" and "this issue", with a
list of what could not be measured.

---

## Common problems

**`Missing DATABASE_URL`**
Your `.env` is missing or in the wrong place. It belongs in the repository root, next to
`package.json`.

**`ECONNREFUSED` when running anything**
Postgres is not running. `brew services start postgresql@16`, or `sudo systemctl start postgresql`,
or `docker start compass-db`.

**`database "compass" does not exist`**
You skipped Step 2. Run `createdb compass`.

**The shortlist is empty**
Try `--min-score 0`. If that is also empty you have no issues yet — run the four steps in
[Your first run](#your-first-run). `npm run compass -- status` shows what data you have.

**Everything scores low, or `responsiveness not measured` everywhere**
You have not run `sync metrics` yet. That is the step that makes the ranking meaningful.

**`Missing GITHUB_TOKEN` when syncing**
Add it to `.env` and restart. Reading existing data does not need a token; fetching new data does.

**`GitHub 401: Bad credentials`**
The token is wrong, expired, or has a stray space in it. Generate a fresh one.

**A sync stopped early saying the budget is low**
Working as intended. You are near your hourly GitHub limit. It resumes from where it stopped — wait an
hour and run it again.

**The web interface says it cannot reach the API**
The server is not running. `npm start`.

More detail: [Troubleshooting](docs/troubleshooting.md).

---

## Full documentation

| Document | What is in it |
|---|---|
| [Getting started](docs/getting-started.md) | A longer walkthrough with a complete worked example |
| [How ranking works](docs/how-ranking-works.md) | Every signal, every weight, and which are measured versus assumed |
| [CLI reference](docs/cli-reference.md) | Every command and flag, with examples |
| [API reference](docs/api-reference.md) | Every endpoint, with request and response examples |
| [Configuration](docs/configuration.md) | Every environment variable |
| [Database](docs/database.md) | Tables, columns, and migrations |
| [Architecture](docs/architecture.md) | Module layout and the rules that keep it testable |
| [Development](docs/development.md) | Tests, conventions, and how to add a signal or a migration |
| [Troubleshooting](docs/troubleshooting.md) | Errors and what they mean |
| [Roadmap](docs/roadmap.md) | What is built, what is not, and what to do next |
| [Design notes](docs/design-notes.md) | The reasoning, and the corrections real data forced |

---

## Honest limitations

Worth knowing before you rely on it:

- **The scoring weights have never been validated against an outcome.** They are a considered starting
  position, not a model fitted to anything. Recording your decisions is what fixes that.
- **Framework detection has a fixed vocabulary** of 34 common frameworks and libraries. A
  project built on something outside that list shows no "built with" tag — absent, not absent-of-tech.
- **Single user.** No accounts, no authentication, bound to localhost. Do not put it on a network.
- **Everything is a snapshot.** Maintainer behaviour changes; a metric from a month ago may be stale.
  Re-run `sync metrics` occasionally.

---

## Licence

No licence file is included — add one before publishing. If you want others to use and modify this,
[MIT](https://choosealicense.com/licenses/mit/) is the usual choice;
[choosealicense.com](https://choosealicense.com) walks through the options.
