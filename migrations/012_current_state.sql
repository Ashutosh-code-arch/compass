-- Phase 2: current state, so choosing an issue stops wasting evenings.
--
-- Phase 1 answers "which organisation". This answers "is this specific issue actually free, and is
-- anyone home to review it" — and both of those are the third provenance class: they DECAY. A
-- measurement of setup cost is good until the repository changes; a claim is good until somebody else
-- comments. So everything here carries the moment it was observed, and nothing here is presented
-- without its age.

-- ---------------------------------------------------------------------------
-- PR queue depth, on the repository
-- ---------------------------------------------------------------------------
--
-- Rides along with the metrics sync, which already queries pull requests. The count is exact rather
-- than sampled: the existing query reads the most recent 40 PRs, so counting open ones among those
-- would have said "40" for a repository with 900 and been indistinguishable from one with 40.
-- GraphQL's totalCount on a filtered connection gives the real number for no extra request.

-- NOT called open_prs. That column already exists and means something narrower and different: open
-- EXTERNAL pull requests inside the sampled window, which is the denominator for open_stale_rate and
-- therefore for the dormancy rule. Reusing the name would have merged two facts that are used for
-- opposite purposes, and the collision is the reason this comment exists.
alter table repo_metrics
  -- Every open pull request in the repository, any author, exact rather than sampled. Null means
  -- unmeasured; an empty queue stores 0, and the difference is the usual one.
  add column open_pr_total integer,
  -- The oldest open pull request. A queue of 200 that turns over weekly is a busy project; a queue of
  -- 12 whose oldest has sat for three years is a project that does not merge, and the count alone
  -- cannot tell those apart.
  add column oldest_open_pr_at timestamptz,
  add column oldest_open_pr_number integer;

comment on column repo_metrics.open_pr_total is
  'Every open pull request in the repository, from a filtered totalCount. Distinct from open_prs, '
  'which counts only open EXTERNAL pull requests inside the sampled responsiveness window. Null '
  'means unmeasured.';

comment on column repo_metrics.open_prs is
  'Open EXTERNAL pull requests within the sampled window. The denominator for open_stale_rate and '
  'the dormancy rule -- NOT the size of the review queue. See open_pr_total for that.';

-- ---------------------------------------------------------------------------
-- Claim state, on the issue
-- ---------------------------------------------------------------------------
--
-- The single biggest time sink on popular repositories: a `good first issue` with 23 comments is
-- usually twenty people asking "can I work on this?" and one person three days in without an
-- assignment. GitHub's assignee field is empty in all of those cases, so the shortlist currently
-- treats them as free.
--
-- Fetched ON DEMAND only, one request per issue you actually open — the same pattern `why` uses. A
-- corpus-wide comment sync would cost tens of thousands of requests to answer a question about the
-- five issues anyone looks at.
--
-- This is a CACHE of a decaying observation, not a measurement. Every row is dated and every reader
-- is shown the age.

create table issue_claims (
  issue_id        bigint primary key references issues (id) on delete cascade,
  checked_at      timestamptz not null default now(),

  verdict         text not null
    check (verdict in ('free', 'claimed', 'contested', 'in-progress', 'stale-claim')),

  -- Distinct people who expressed intent to take the issue, excluding bots and excluding anyone who
  -- only asked whether somebody else was working on it.
  claimants       integer not null,
  latest_claim_at timestamptz,
  latest_claimant text,

  -- Someone reporting actual work rather than intent: a pull request reference, a push, a branch. The
  -- distinction matters because intent decays and work does not.
  progress_at     timestamptz,
  progress_by     text,

  -- Pull requests referenced in the thread. The cheapest possible signal that the work exists.
  linked_prs      text[] not null default '{}',

  -- Bounty mentions found in comments. Labels are read separately and need no fetch.
  bounty_hint     text,

  -- How much of the thread was actually read. A verdict from the first 100 comments of a 400-comment
  -- thread is a different quality of claim, and the reader has to be able to tell.
  comments_read   integer not null,
  comments_total  integer not null
);

-- "Which of the issues on this page have I already checked" is the read pattern.
create index issue_claims_checked_idx on issue_claims (checked_at);

comment on table issue_claims is
  'On-demand cache of a DECAYING observation. A verdict is true as of checked_at and no longer; the '
  'UI and CLI both show its age rather than presenting it as a fact about the present.';

comment on column issue_claims.verdict is
  'free: nobody asked. claimed: one recent request. contested: several people asked and nobody was '
  'assigned - the case that wastes evenings. in-progress: someone reported actual work. stale-claim: '
  'a request old enough that the issue is probably free again.';
