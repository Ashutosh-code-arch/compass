/**
 * The on-demand claim check: one issue, one or two requests, a dated verdict.
 *
 * Why on demand. A corpus of 306,000 issues would need tens of thousands of requests to answer a
 * question about the five issues anybody actually looks at, and the answer would be stale before the
 * sync finished. This is the pattern `why` already uses — pay for depth at the moment the depth is
 * wanted — and it is the only shape in which this feature is affordable.
 *
 * Why the result is stored. It is a decaying observation, so the row is a cache and not a measurement:
 * every read shows its age, and a stale row can be refreshed rather than silently trusted. Storing it
 * also means the shortlist can show what you already know about issues you have checked, without
 * spending anything.
 */

import { Budget, GitHubRest } from '../github/rest.ts';
import { db } from '../db.ts';
import { bountyLabels, detectClaims, type ClaimComment, type ClaimFinding } from './detect.ts';

/**
 * How many comments to read.
 *
 * A hundred, in one page. The signal lives at both ends of a thread — the first people to ask and the
 * most recent state — and reading the first hundred captures every early claim, which is where the
 * twenty-volunteers pattern shows. Threads longer than this report the shortfall rather than pretending
 * to completeness.
 */
export const COMMENT_PAGE = 100;

export interface ClaimCheck extends ClaimFinding {
  issueId: number;
  repoFullName: string;
  number: number;
  title: string;
  htmlUrl: string;
  /** When the verdict was formed. Always shown, never implied to be now. */
  checkedAt: string;
  /** Bounty labels, which cost nothing and are available whether or not comments were read. */
  bountyLabels: string[];
  /** True when the row came from the cache rather than from a fresh fetch. */
  fromCache: boolean;
}

interface IssueRow {
  id: number;
  number: number;
  title: string;
  html_url: string;
  labels: string[];
  comment_count: number;
  full_name: string;
  author_login: string | null;
}

interface RestComment {
  user: { login: string; type: string } | null;
  author_association: string;
  body: string | null;
  created_at: string;
}

/** Splits `owner/name#123`. Mirrors the shortlist's reference parsing. */
function parseRef(ref: string): { fullName: string; number: number } {
  const match = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(ref.trim());
  if (!match) throw new Error(`Expected owner/name#123, got "${ref}"`);
  return { fullName: match[1]!, number: Number(match[2]) };
}

async function loadIssue(ref: string): Promise<IssueRow | null> {
  const { fullName, number } = parseRef(ref);
  return (
    (
      await db().query<IssueRow>(
        `select i.id, i.number, i.title, i.html_url, i.labels, i.comment_count,
                r.full_name, i.author_login
           from issues i
           join repos r on r.id = i.repo_id
          where r.full_name = $1 and i.number = $2`,
        [fullName, number],
      )
    ).rows[0] ?? null
  );
}

/** A cached verdict, or null when the issue has never been checked. */
export async function readCachedClaim(issueId: number): Promise<ClaimCheck | null> {
  const row = (
    await db().query<{
      checked_at: Date;
      verdict: string;
      claimants: number;
      latest_claim_at: Date | null;
      latest_claimant: string | null;
      progress_at: Date | null;
      progress_by: string | null;
      linked_prs: string[];
      bounty_hint: string | null;
      comments_read: number;
      comments_total: number;
      number: number;
      title: string;
      html_url: string;
      labels: string[];
      full_name: string;
    }>(
      `select c.*, i.number, i.title, i.html_url, i.labels, r.full_name
         from issue_claims c
         join issues i on i.id = c.issue_id
         join repos r on r.id = i.repo_id
        where c.issue_id = $1`,
      [issueId],
    )
  ).rows[0];
  if (!row) return null;

  return {
    issueId,
    repoFullName: row.full_name,
    number: row.number,
    title: row.title,
    htmlUrl: row.html_url,
    checkedAt: row.checked_at.toISOString(),
    verdict: row.verdict as ClaimCheck['verdict'],
    claimants: row.claimants,
    // The cache keeps the counts and the headline actors, not every matched comment. The full events
    // are evidence for a fresh check; re-reading a thread to redisplay them would defeat the point.
    claims:
      row.latest_claimant === null || row.latest_claim_at === null
        ? []
        : [
            {
              author: row.latest_claimant,
              at: row.latest_claim_at.toISOString(),
              why: 'most recent request',
              excerpt: '',
            },
          ],
    progress:
      row.progress_by === null || row.progress_at === null
        ? []
        : [{ author: row.progress_by, at: row.progress_at.toISOString(), why: 'reported work', excerpt: '' }],
    linkedPrs: row.linked_prs,
    bountyHint: row.bounty_hint,
    bountyLabels: bountyLabels(row.labels),
    commentsRead: row.comments_read,
    commentsTotal: row.comments_total,
    fromCache: true,
  };
}

export interface CheckClaimsOptions {
  /** Use a cached verdict if one exists. Off by default: an explicit check means "look now". */
  allowCache?: boolean;
  now?: Date;
}

/**
 * Checks one issue and stores the verdict.
 *
 * Costs one request for the comments, or zero when the issue has none — the corpus already knows the
 * comment count, so a thread with nothing in it is answered without touching the network.
 */
export async function checkClaims(
  ref: string,
  options: CheckClaimsOptions = {},
): Promise<ClaimCheck | null> {
  const issue = await loadIssue(ref);
  if (!issue) return null;

  if (options.allowCache === true) {
    const cached = await readCachedClaim(issue.id);
    if (cached) return cached;
  }

  const now = options.now ?? new Date();
  let comments: ClaimComment[] = [];

  if (issue.comment_count > 0) {
    // GITHUB_TOKEN is required only here, at the network call, so every other path in this module — and
    // the whole cached read — keeps working on a restored database with no token.
    const rest = new GitHubRest(new Budget());
    const response = await rest.get<RestComment[]>(
      `/repos/${issue.full_name}/issues/${issue.number}/comments`,
      { query: { per_page: COMMENT_PAGE }, tolerate: [404, 410] },
    );
    comments = (response.data ?? []).map((raw) => ({
      author: raw.user?.login ?? null,
      authorType: raw.user?.type ?? null,
      authorAssociation: raw.author_association,
      body: raw.body ?? '',
      createdAt: raw.created_at,
    }));
  }

  const finding = detectClaims({
    comments,
    // The stored count, not the fetched length: that is how a truncated read becomes visible instead of
    // looking like a complete one.
    commentsTotal: issue.comment_count,
    issueAuthor: issue.author_login,
    now,
  });

  await db().query(
    `insert into issue_claims (issue_id, checked_at, verdict, claimants, latest_claim_at,
                               latest_claimant, progress_at, progress_by, linked_prs, bounty_hint,
                               comments_read, comments_total)
     values ($1, $2, $3, $4, $5::timestamptz, $6, $7::timestamptz, $8, $9::text[], $10, $11, $12)
     on conflict (issue_id) do update set
       checked_at = excluded.checked_at,
       verdict = excluded.verdict,
       claimants = excluded.claimants,
       latest_claim_at = excluded.latest_claim_at,
       latest_claimant = excluded.latest_claimant,
       progress_at = excluded.progress_at,
       progress_by = excluded.progress_by,
       linked_prs = excluded.linked_prs,
       bounty_hint = excluded.bounty_hint,
       comments_read = excluded.comments_read,
       comments_total = excluded.comments_total`,
    [
      issue.id,
      now.toISOString(),
      finding.verdict,
      finding.claimants,
      finding.claims[0]?.at ?? null,
      finding.claims[0]?.author ?? null,
      finding.progress[0]?.at ?? null,
      finding.progress[0]?.author ?? null,
      finding.linkedPrs,
      finding.bountyHint,
      finding.commentsRead,
      finding.commentsTotal,
    ],
  );

  return {
    ...finding,
    issueId: issue.id,
    repoFullName: issue.full_name,
    number: issue.number,
    title: issue.title,
    htmlUrl: issue.html_url,
    checkedAt: now.toISOString(),
    bountyLabels: bountyLabels(issue.labels),
    fromCache: false,
  };
}
