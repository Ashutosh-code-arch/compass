/**
 * Types mirroring src/rank/view.ts, and a thin fetch wrapper.
 *
 * Hand-mirrored rather than generated: the shapes are small and stable, and a codegen step would be
 * more machinery than this earns. If they drift, the compiler here will not catch it — the contract
 * tests on the server side are what protect the shape.
 */

export interface ScoreLine {
  signal: string;
  points: number;
  detail: string;
  about: 'repo' | 'issue';
}

export interface IssueRef {
  issueId: number;
  repoFullName: string;
  number: number;
  title: string;
  htmlUrl: string;
  labels: string[];
}

export interface RowContext {
  responsiveness: string | null;
  confidence: string | null;
  medianHoursResponse: number | null;
  noResponseRate: number | null;
  setupWeight: string | null;
  primaryLanguage: string | null;
  stars: number;
}

export interface ShortlistRow {
  rank: number;
  score: number;
  issue: IssueRef;
  evidence: ScoreLine[];
  subtotals: { repo: number; issue: number };
  context: RowContext;
  heldBackInRepo: number;
}

export type ShortlistNotice =
  | { kind: 'no-candidates' }
  | { kind: 'none-scoring'; considered: number; minScore: number }
  | { kind: 'fetch-cap-hit'; fetchLimit: number };

export interface ShortlistView {
  summary: {
    considered: number;
    scoring: number;
    shown: number;
    /** Rows available after the per-repo cap, across all pages. Paging bound, not `scoring`. */
    total: number;
    offset: number;
    repos: number;
    minScore: number;
    perRepo: number;
    limit: number;
    scoreRange: { min: number; max: number; median: number } | null;
  };
  rows: ShortlistRow[];
  notices: ShortlistNotice[];
}

export interface WhyView {
  issue: IssueRef;
  score: number;
  repoLines: ScoreLine[];
  issueLines: ScoreLine[];
  repoSubtotal: number;
  issueSubtotal: number;
  unmeasured: string[];
}

export type Verdict =
  | 'shortlisted'
  | 'rejected'
  | 'started'
  | 'abandoned'
  | 'submitted'
  | 'merged'
  | 'closed_unmerged'
  | 'stalled';

export interface JournalEntry {
  repoFullName: string;
  number: number;
  title: string;
  trail: Verdict[];
  latestVerdict: Verdict;
  predictedHours: number | null;
  actualHours: number | null;
  ratio: number | null;
  reason: string | null;
  lastAt: string;
}

export interface JournalView {
  entries: JournalEntry[];
  complete: number;
  meanRatio: number | null;
}

export type SetupWeight = 'light' | 'moderate' | 'heavy';

export interface LanguageCount {
  language: string;
  repos: number;
}

export type RunKind = 'seed' | 'repos' | 'issues' | 'metrics' | 'setup';

export interface RunRecord {
  runId: number;
  kind: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  reposSeen: number;
  reposUpserted: number;
  issuesUpserted: number;
  requests: number;
  notModified: number;
  error: string | null;
}

export interface SyncStatus {
  kinds: RunKind[];
  active: { kind: RunKind; startedAt: string; options: Record<string, unknown> } | null;
  runningElsewhere: { runId: number; kind: string; startedAt: string; heartbeatRequests: number }[];
  tokenConfigured: boolean;
  corpus: {
    repos: number;
    pausedRepos: number;
    issues: number;
    openIssues: number;
    reposWithMetrics: number;
    reposWithSetup: number;
    staleMetadata: number;
    decisions: number;
  };
  runs: RunRecord[];
}

export interface Profile {
  languagePoints: Record<string, number>;
  topicPoints: Record<string, number>;
  avoidTopics: string[];
  avoidLabels: string[];
  minStars: number | null;
  maxStars: number | null;
  maxSetupWeight: SetupWeight | null;
}

export interface ProfileEnvelope {
  profile: Profile;
  /** What an empty profile falls back to, so the screen can show it rather than imply nothing. */
  defaults: { languagePoints: Record<string, number> };
  maxPoints: number;
}

export interface Filters {
  limit?: number;
  offset?: number;
  minScore?: number;
  perRepo?: number;
  language?: string;
  labelledOnly?: boolean;
  includeDormant?: boolean;
  maxSetupWeight?: string;
  minStars?: number;
  maxStars?: number;
}

/** The server names its query parameters after the CLI flags; keep the mapping in one place. */
export function toQuery(filters: Filters): string {
  const params = new URLSearchParams();
  const set = (key: string, value: string | number | boolean | undefined): void => {
    if (value === undefined || value === '') return;
    params.set(key, String(value));
  };
  set('limit', filters.limit);
  if (filters.offset) set('offset', filters.offset);
  set('min-score', filters.minScore);
  set('per-repo', filters.perRepo);
  set('language', filters.language);
  set('max-setup', filters.maxSetupWeight);
  set('min-stars', filters.minStars);
  set('max-stars', filters.maxStars);
  // Booleans are only sent when true: the server treats an absent flag as false, and sending
  // `labelled=false` would be indistinguishable in intent but noisier in the URL.
  if (filters.labelledOnly) set('labelled', true);
  if (filters.includeDormant) set('include-dormant', true);
  return params.toString();
}

/** The server puts a human-readable reason in `error`; surface it rather than a status code. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      // A non-JSON body means the server is not the one we think it is; the status will have to do.
    }
    throw new Error(detail);
  }
  return (await response.json()) as T;
}

export const api = {
  shortlist: (filters: Filters): Promise<ShortlistView> =>
    request<ShortlistView>(`/api/shortlist?${toQuery(filters)}`),

  why: (repoFullName: string, number: number): Promise<WhyView> =>
    request<WhyView>(`/api/issues/${repoFullName}/${number}/why`),

  journal: (limit = 50): Promise<JournalView> =>
    request<JournalView>(`/api/journal?limit=${limit}`),

  languages: (): Promise<{ languages: LanguageCount[] }> => request('/api/languages'),

  syncStatus: (): Promise<SyncStatus> => request<SyncStatus>('/api/sync'),

  startSync: (
    kind: RunKind,
    options: { limit?: number; repo?: string; staleHours?: number; staleDays?: number },
  ): Promise<{ started: NonNullable<SyncStatus['active']> }> =>
    request(`/api/sync/${kind}`, { method: 'POST', body: JSON.stringify(options) }),

  profile: (): Promise<ProfileEnvelope> => request<ProfileEnvelope>('/api/profile'),

  saveProfile: (profile: Profile): Promise<{ profile: Profile }> =>
    request('/api/profile', { method: 'PUT', body: JSON.stringify(profile) }),

  decide: (body: {
    ref: string;
    verdict: Verdict;
    predictedHours?: number;
    actualHours?: number;
    reason?: string;
  }): Promise<unknown> =>
    request('/api/decisions', { method: 'POST', body: JSON.stringify(body) }),
};

export const VERDICTS: Verdict[] = [
  'shortlisted',
  'started',
  'submitted',
  'merged',
  'stalled',
  'abandoned',
  'closed_unmerged',
  'rejected',
];
