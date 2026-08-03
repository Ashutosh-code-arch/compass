/**
 * Only the fields the sync reads. Everything else is preserved verbatim in the `raw` jsonb
 * column, so widening these interfaces later never requires re-fetching.
 */

export interface GhUser {
  login: string;
  id: number;
  type?: string;
}

export interface GhLicense {
  spdx_id?: string | null;
  key?: string;
}

export interface GhRepo {
  id: number;
  node_id: string;
  full_name: string;
  name: string;
  owner: GhUser;
  description: string | null;
  homepage?: string | null;
  language: string | null;
  topics?: string[];
  license?: GhLicense | null;
  stargazers_count: number;
  forks_count: number;
  watchers_count?: number;
  subscribers_count?: number;
  /** Includes open pull requests. Not a usable issue count on its own. */
  open_issues_count: number;
  size: number;
  archived: boolean;
  disabled: boolean;
  fork: boolean;
  has_issues: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  pushed_at: string | null;
}

export interface GhLabel {
  name: string;
}

export interface GhIssue {
  id: number;
  node_id: string;
  number: number;
  title: string;
  body: string | null;
  state: string;
  state_reason?: string | null;
  labels: (GhLabel | string)[];
  assignees?: GhUser[] | null;
  assignee?: GhUser | null;
  user: GhUser | null;
  author_association?: string;
  comments: number;
  locked?: boolean;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  html_url: string;
  /** Present iff this "issue" is actually a pull request. The only reliable discriminator. */
  pull_request?: unknown;
}

export interface GhSearchResponse<T> {
  total_count: number;
  incomplete_results: boolean;
  items: T[];
}

export function labelNames(labels: GhIssue['labels']): string[] {
  return labels
    .map((label) => (typeof label === 'string' ? label : label.name))
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
}

export function assigneeLogins(issue: GhIssue): string[] {
  const list = issue.assignees?.length ? issue.assignees : issue.assignee ? [issue.assignee] : [];
  return [...new Set(list.map((user) => user.login))];
}

export function isPullRequest(issue: GhIssue): boolean {
  return issue.pull_request !== undefined && issue.pull_request !== null;
}
