# Getting started

A complete walkthrough, from an empty database to your first recorded decision. Assumes you have
finished the [setup steps in the README](../README.md#setup-step-by-step).

Roughly 30 minutes, most of it waiting for GitHub.

---

## What we are going to do

1. [Check the plumbing](#1-check-the-plumbing)
2. [Find some projects](#2-find-some-projects)
3. [Pull their issues](#3-pull-their-issues)
4. [Measure maintainer attention](#4-measure-maintainer-attention)
5. [Measure setup cost](#5-measure-setup-cost)
6. [Read your first shortlist](#6-read-your-first-shortlist)
7. [Interrogate a row](#7-interrogate-a-row)
8. [Tell it what you want](#8-tell-it-what-you-want)
9. [Record a decision](#9-record-a-decision)
10. [Close the loop](#10-close-the-loop)

---

## 1. Check the plumbing

```bash
npm run status
```

Expect something like:

```
Corpus:      0 repos, 0 issues
Metrics:     0 repos measured
Setup:       0 repos read
Decisions:   0 recorded
Recent runs: none
```

Zeros are correct — the database is empty. If instead you see an error, go to
[Troubleshooting](troubleshooting.md); nothing below will work until this command runs cleanly.

---

## 2. Find some projects

```bash
npm run compass -- seed
```

This runs the searches in `src/seeds/queries.ts`, which deliberately target repositories with
1,000–30,000 stars. Below about 500 stars, abandonment risk starts to dominate; above about 50,000, the
labelled beginner issues get claimed within hours.

Takes two or three minutes. Then:

```bash
npm run status
```

```
Corpus:      1076 repos, 0 issues
```

Numbers will differ — GitHub search results are not stable.

> **Want to see what it would do first?** `npm run compass -- seed --dry-run` prints the queries and
> result counts without writing anything.

---

## 3. Pull their issues

```bash
npm run compass -- sync issues --limit 100
```

**Start with the limit.** This is the slowest step, and you want to watch it work before committing an
hour. A hundred projects takes a few minutes.

You will see progress per repository. When it finishes:

```bash
npm run status
```

```
Corpus:      1076 repos, 8214 issues
```

Once you are happy, drop the limit and let it run through the rest.

---

## 4. Measure maintainer attention

```bash
npm run compass -- sync metrics --limit 100
```

**This is the step that makes Compass worth using.** Everything else is metadata you could have got from
a GitHub search. This reads the last 180 days of pull requests from outside contributors and works out
whether anyone reviews them, how fast, and how often they actually merge.

Have a look at what it found:

```bash
npm run compass -- maintainers --sort median --limit 10
```

```
repo                        responsiveness  median   ignored   merged   confidence
acme/widgets                responsive         6h        9%      85%    high
other/project               moderate          31h       18%      61%    high
slow/thing                  slow             140h       44%      30%    medium
```

That table is the whole point. `slow/thing` answers fewer than half its outside pull requests and merges
under a third of the ones it does. Nothing about its labels or its setup makes that a good place to spend
five hours.

> **Some projects will show `unknown` or `low` confidence.** That means too few external pull requests to
> judge — unmeasured, not bad. Compass halves repository signals on thin samples rather than pretending
> to know.

---

## 5. Measure setup cost

```bash
npm run compass -- sync setup --limit 100
```

Reads root-level files — compose files, env templates, task runners, CI config — and produces a
`light` / `moderate` / `heavy` verdict.

```bash
npm run compass -- setup --sort weight --limit 10
```

```
repo                   weight     services  env vars  runner   ci-on-pr
acme/widgets           light             -         3  npm      yes
big/platform           heavy             7        31  make     yes
```

`big/platform` needs seven containers up and thirty-one environment variables filled in before you can
run a test. That is most of an evening before you write a line of code.

---

## 6. Read your first shortlist

```bash
npm run compass -- shortlist
```

```
15 of 412 open unassigned issues score at least 20 (range 24–104, median 61).
Showing 6 from 3 repositories, at most 2 each (--per-repo to change).

  1. [104]  acme/widgets#11  Fix off-by-one in the pagination helper
      +16 invited (labelled "good first issue")  +6 uncontested (1 comment)
      responsive · 6h · setup light · TypeScript
      https://github.com/acme/widgets/issues/11
      (+8 more scoring candidates in this repo)
```

Or open <http://127.0.0.1:8787> and use the **Shortlist** tab, which shows the same data with the
provenance bar and clickable breakdowns.

**Nothing there?** Two possibilities:

```bash
npm run compass -- shortlist --min-score 0     # include the weak candidates
```

If that shows rows, your corpus simply has nothing strong yet — sync more projects. If it is still empty,
run `npm run status` and check that metrics were actually collected.

### Reading the summary line

`15 of 412` — 412 issues passed the gates (open, unassigned, unlocked, unjudged, not in a dormant
project), and 15 of those cleared the score threshold.

`Showing 6 from 3 repositories, at most 2 each` — the per-repository cap. Without it, one good project
takes over the list; on a real run, twelve of the top twenty came from the same repository on an identical
score.

`(+8 more scoring candidates in this repo)` — the cap held eight back. They exist, and `--per-repo 5`
would show more of them.

---

## 7. Interrogate a row

This is the part that makes the tool trustworthy rather than magical.

```bash
npm run compass -- why acme/widgets#11
```

```
acme/widgets#11  —  score 102
Fix off-by-one in the pagination helper
https://github.com/acme/widgets/issues/11

  the project
    +22  responsiveness  responsive, median 6h
    +16  merge rate      85% of 21 decided outside PRs merged
    +12  setup           light
    +12  onboarding      CONTRIBUTING, CI on PRs, make
    subtotal 80

  this issue
    +16  invited         labelled "good first issue"
     +6  uncontested     1 comment
    subtotal 22
  ======
    102  total

Labels: good first issue, bug
Weights live in src/rank/weights.ts — disagree with a line and change it there.
```

Three things to take from this.

**Every line carries its raw value.** `85% of 21 decided outside PRs merged` — not "good merge rate". You
can check that claim.

**80 of the 102 points came from the project.** This is really a recommendation of `acme/widgets`. Any of
its issues would do, which is exactly what `+8 more scoring candidates` was telling you.

**The total is the least interesting number here.** It has no units. It exists to sort.

If a line looks wrong, the weight is in `src/rank/weights.ts` and you should change it. If the *measurement*
looks wrong, recompute just that project:

```bash
npm run compass -- sync metrics --repo acme/widgets --stale-days 0
npm run compass -- explain acme/widgets     # the per-PR evidence behind the numbers
```

---

## 8. Tell it what you want

Open the **What you want** tab.

Out of the box, languages use built-in defaults (`TypeScript` and `Python` 14, `Go` 8, and so on). To make
it yours:

1. Under **Languages**, add `Python` with `20`
2. Under **Subjects**, add `developer-tools` with `8` — matched against a project's GitHub topics
3. Under **Steer away from**, add a project topic you do not want, say `blockchain`
4. Under **Default filters**, set **Fewest stars** to `500`
5. Click **Save and re-rank**

Go back to the **Shortlist**. The order will have changed. Expand a row and you will see the new lines in
the breakdown — `+20 language (Python)`, or `−14 avoided subject (tagged "blockchain")`.

Three things worth knowing:

**Adding any language replaces the defaults entirely.** Once you list Python, TypeScript scores nothing.
Deleting a language should mean it stops counting, not that it quietly reverts to 14.

**Preferences are capped at ±25.** The largest measured weight is 22. A preference bigger than every
measurement turns the ranking into a filter — and the filters on the left are the right tool for excluding
things.

**Avoid terms subtract; they do not exclude.** A `−14` still leaves a strong project visible, and you can
see why it was marked down.

---

## 9. Record a decision

Pick something from your shortlist and open it on GitHub. Read the issue. Decide whether you believe what
Compass told you.

Then, whatever you concluded, record it. In the app: **Record a decision**. Or:

```bash
# Not for you
npm run compass -- decide acme/widgets#11 rejected --reason "needs a design discussion first"

# Going to try it — with your honest guess at how long
npm run compass -- decide other/project#88 started --hours 4
```

**The `--hours` guess is the important part**, and it will feel pointless the first few times. It is the
only input the tool has ever had that could tell it whether its weights are any good.

Recording anything removes the issue from future shortlists, so rejections are useful too — they stop the
same trap being offered next week.

---

## 10. Close the loop

When you finish the work — or give up on it — record what actually happened:

```bash
npm run compass -- decide other/project#88 merged --actual-hours 9
```

Then:

```bash
npm run compass -- journal
```

```
2026-08-02  started -> merged        other/project#88  4h predicted, 9h actual (2.3x)
            Add a --dry-run flag to the importer

No issue yet has both a prediction and an outcome for three issues. 3 is where the average starts
meaning anything.
```

Or the **What you decided** tab, which shows progress toward the threshold.

**After three complete pairs** you get an average — how far your estimates run from reality. On the one
recorded pair so far in development, the work took 2.3× the estimate.

**After about fifteen**, you have enough to argue with the weights from evidence rather than intuition.
That is the point at which Compass stops being a considered guess and starts being calibrated to you.

The average is deliberately withheld below three pairs, and the server will not send it. An average over
one or two ratios is exactly the false precision the tool refuses everywhere else.

---

## Keeping it current

Maintainer behaviour changes. A weekly habit is plenty:

```bash
npm run compass -- sync repos              # cheap, mostly 304s
npm run compass -- sync issues             # new and updated issues
npm run compass -- sync metrics            # skips anything measured in the last 7 days
npm run compass -- prune --dormant --apply # stop syncing projects nobody attends
```

`prune` is reversible — it pauses, it does not delete. `--unpause --apply` restores everything.

Once your corpus passes about a thousand repositories, `sync repos` needs two passes: it defaults to
`--limit 1000`.

---

## Where to go next

- [How ranking works](how-ranking-works.md) — every signal and weight, and which are measured versus assumed
- [CLI reference](cli-reference.md) — every command and flag
- [Troubleshooting](troubleshooting.md) — when something breaks
- [Roadmap](roadmap.md) — what is not built yet
