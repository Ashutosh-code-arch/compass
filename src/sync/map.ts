import { jsonb, stripNul } from '../db.ts';
import {
  assigneeLogins,
  labelNames,
  type GhIssue,
  type GhRepo,
} from '../github/types.ts';

/** Column order is derived from these arrays, so a mapper can never drift out of alignment. */
export const REPO_COLUMNS = [
  'id',
  'node_id',
  'full_name',
  'owner',
  'name',
  'description',
  'homepage',
  'primary_language',
  'topics',
  'license_spdx',
  'stars',
  'forks',
  'watchers',
  'open_issues_raw',
  'size_kb',
  'is_archived',
  'is_disabled',
  'is_fork',
  'has_issues',
  'default_branch',
  'created_at_gh',
  'updated_at_gh',
  'pushed_at',
  'discovered_via',
  'raw',
] as const;

/**
 * Overwritten on every sighting. Deliberately excluded: node_id (immutable), discovered_at and
 * discovered_via (first sighting wins, so the attribution stays meaningful), and all the sync
 * bookkeeping columns, which the sync steps own.
 */
export const REPO_UPDATE_COLUMNS = REPO_COLUMNS.filter(
  (column) => !['id', 'node_id', 'discovered_via'].includes(column),
);

export function mapRepoRow(repo: GhRepo, discoveredVia: string): unknown[] {
  const record: Record<string, unknown> = {
    id: repo.id,
    node_id: repo.node_id,
    full_name: repo.full_name,
    owner: repo.owner.login,
    name: repo.name,
    description: stripNul(repo.description),
    homepage: stripNul(repo.homepage ?? null),
    primary_language: repo.language,
    topics: repo.topics ?? [],
    license_spdx: repo.license?.spdx_id ?? null,
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    // In most repo payloads `watchers_count` is a duplicate of the star count; `subscribers_count`
    // is the real watcher figure and only appears on the single-repo endpoint.
    watchers: repo.subscribers_count ?? repo.watchers_count ?? 0,
    open_issues_raw: repo.open_issues_count,
    size_kb: repo.size,
    is_archived: repo.archived,
    is_disabled: repo.disabled ?? false,
    is_fork: repo.fork,
    has_issues: repo.has_issues,
    default_branch: repo.default_branch,
    created_at_gh: repo.created_at,
    updated_at_gh: repo.updated_at,
    pushed_at: repo.pushed_at,
    discovered_via: discoveredVia,
    raw: jsonb(repo),
  };
  return REPO_COLUMNS.map((column) => record[column]);
}

export const ISSUE_COLUMNS = [
  'id',
  'node_id',
  'repo_id',
  'number',
  'title',
  'body',
  'state',
  'state_reason',
  'labels',
  'assignee_logins',
  'author_login',
  'author_association',
  'comment_count',
  'is_locked',
  'created_at_gh',
  'updated_at_gh',
  'closed_at_gh',
  'html_url',
  'raw',
] as const;

/** first_seen_at is preserved; last_synced_at is bumped via extraSet. */
export const ISSUE_UPDATE_COLUMNS = ISSUE_COLUMNS.filter(
  (column) => !['id', 'node_id', 'repo_id', 'created_at_gh'].includes(column),
);

export function mapIssueRow(issue: GhIssue, repoId: number): unknown[] {
  const record: Record<string, unknown> = {
    id: issue.id,
    node_id: issue.node_id,
    repo_id: repoId,
    number: issue.number,
    title: stripNul(issue.title),
    body: stripNul(issue.body),
    // The API only ever returns open or closed here; normalise defensively so the CHECK holds.
    state: issue.state === 'closed' ? 'closed' : 'open',
    state_reason: issue.state_reason ?? null,
    labels: labelNames(issue.labels),
    assignee_logins: assigneeLogins(issue),
    author_login: issue.user?.login ?? null,
    author_association: issue.author_association ?? null,
    comment_count: issue.comments,
    is_locked: issue.locked ?? false,
    created_at_gh: issue.created_at,
    updated_at_gh: issue.updated_at,
    closed_at_gh: issue.closed_at,
    html_url: issue.html_url,
    raw: jsonb(issue),
  };
  return ISSUE_COLUMNS.map((column) => record[column]);
}
