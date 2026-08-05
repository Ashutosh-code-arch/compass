/**
 * Adding a project you actually care about.
 *
 * Until this existed, the corpus was whatever the seed searches happened to find. If you wanted to
 * contribute to Django, there was no way to ask — `sync repos --repo django/django` selects
 * `from repos where full_name = $1`, so for a repository that is not already present it matched
 * nothing and reported "Nothing to refresh", which reads like success.
 *
 * This fetches the repository directly and, by default, does the rest of the pipeline for it too.
 * Adding a project and being shown nothing would be a strange thing to offer: one repository's issues,
 * metrics and setup facts cost only a few requests, so the useful behaviour is the default.
 */

import { db } from '../db.ts';
import type { GitHubRest } from '../github/rest.ts';
import { mapRepoRow, REPO_COLUMNS, REPO_UPDATE_COLUMNS } from './map.ts';
import { refreshOrganizations } from './orgs.ts';
import { recordStars } from './stars.ts';
import { withSyncRun, type RunSummary } from './run.ts';
import { syncIssues } from './issues.ts';
import { syncMetrics } from './metrics.ts';
import { syncSetup } from './setup.ts';

export interface AddRepoOptions {
  /** Fetch metadata only, leaving issues, metrics and setup for a later run. */
  metadataOnly?: boolean;
}

export class RepoNotFoundError extends Error {}

/** owner/name, tolerating a pasted GitHub URL or a trailing slash. */
export function parseRepoRef(ref: string): { owner: string; name: string } {
  const cleaned = ref
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  const match = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(cleaned);
  if (!match) {
    throw new Error(`Expected owner/name or a GitHub URL, got "${ref}"`);
  }
  return { owner: match[1]!, name: match[2]! };
}

export interface AddedRepo {
  id: number;
  fullName: string;
  stars: number;
  primaryLanguage: string | null;
  alreadyPresent: boolean;
}

interface GhRepo {
  id: number;
  node_id: string;
  full_name: string;
  archived?: boolean;
  disabled?: boolean;
  fork?: boolean;
  has_issues?: boolean;
  stargazers_count?: number;
  language?: string | null;
  [key: string]: unknown;
}

/**
 * Fetches one repository and upserts it, marked as manually added.
 *
 * Takes the run's own client rather than constructing one, so the request is counted against the same
 * budget as every other fetch and shows up in the run's request total.
 *
 * `discovered_via = 'manual'` matters: the seed queries are periodically re-tuned, and a repository
 * you asked for should never be mistaken for one a query found and be pruned on that basis.
 */
export async function addRepo(gh: GitHubRest, ref: string): Promise<AddedRepo> {
  const { owner, name } = parseRepoRef(ref);
  const fullName = `${owner}/${name}`;

  const existing = await db().query<{ id: number }>(
    'select id from repos where lower(full_name) = lower($1)',
    [fullName],
  );

  const result = await gh.get<GhRepo>(`/repos/${owner}/${name}`);
  if (!result.data) {
    throw new RepoNotFoundError(
      `GitHub has no public repository at ${fullName}. Check the spelling, and note that ` +
        `private and deleted repositories cannot be read.`,
    );
  }

  const repo = result.data;
  // The API answers on the canonical name after a rename or transfer, so store what it returned
  // rather than what was typed — otherwise a later sync would create a duplicate row.
  const canonical = repo.full_name ?? fullName;
  if (repo.has_issues === false) {
    console.warn(`[add] ${canonical} has issues disabled, so it will never produce a candidate.`);
  }
  if (repo.archived) {
    console.warn(`[add] ${canonical} is archived. It is added, but archived repos are gated out.`);
  }

  const row = mapRepoRow(repo as never, 'manual');
  const columns = REPO_COLUMNS.join(', ');
  const placeholders = row.map((_unused, index) => `$${index + 1}`).join(', ');
  // REPO_UPDATE_COLUMNS deliberately excludes discovered_via — first sighting wins, so a repository
  // already found by a seed query keeps that attribution. Re-adding it still re-activates it below,
  // which is the part that matters.
  const updates = REPO_UPDATE_COLUMNS.map((column) => `${column} = excluded.${column}`).join(', ');

  const upserted = await db().query<{ id: number }>(
    `insert into repos (${columns}) values (${placeholders})
     on conflict (id) do update set ${updates}
     returning id`,
    row,
  );

  // Re-activate: a repository you explicitly asked for should not stay paused by an earlier prune.
  await db().query(
    `update repos set sync_state = 'active', sync_error = null, sync_error_count = 0
      where id = $1 and sync_state <> 'gone'`,
    [upserted.rows[0]!.id],
  );

  await recordStars([
    { repoId: upserted.rows[0]!.id, stars: repo.stargazers_count ?? 0 },
  ]);
  // A manually added repository is very often the first one from its organisation, which makes this
  // the path that most needs to create the row.
  await refreshOrganizations();

  return {
    id: upserted.rows[0]!.id,
    fullName: canonical,
    stars: repo.stargazers_count ?? 0,
    primaryLanguage: repo.language ?? null,
    alreadyPresent: existing.rows.length > 0,
  };
}

export interface AddResult {
  repo: AddedRepo;
  issues?: RunSummary;
  metrics?: RunSummary;
  setup?: RunSummary;
}

/**
 * Adds a repository and makes it rankable.
 *
 * Wrapped in a `repos` sync run so the request cost is accounted for like any other fetch, and so the
 * corpus screen shows it in the run history rather than the row appearing from nowhere.
 */
export async function addAndPrepare(
  ref: string,
  options: AddRepoOptions = {},
): Promise<AddResult> {
  let repo: AddedRepo | undefined;

  await withSyncRun('repos', async (ctx) => {
    repo = await addRepo(ctx.gh, ref);
    ctx.reposSeen = 1;
    ctx.reposUpserted = 1;
    ctx.detail = { added: repo.fullName, manual: true, alreadyPresent: repo.alreadyPresent };
  });

  if (!repo) throw new Error('add failed before it recorded anything');
  const added = repo;

  console.log(
    `\n${added.alreadyPresent ? 'Updated' : 'Added'} ${added.fullName} — ` +
      `${added.stars.toLocaleString()} stars, ${added.primaryLanguage ?? 'language unknown'}`,
  );

  if (options.metadataOnly) {
    console.log(
      `Metadata only. Run the issue, metric and setup scans for it before it can be ranked:\n` +
        `  npm run compass -- sync issues  --repo ${added.fullName}\n` +
        `  npm run compass -- sync metrics --repo ${added.fullName}\n` +
        `  npm run compass -- sync setup   --repo ${added.fullName}\n`,
    );
    return { repo: added };
  }

  // Sequential, and each is scoped to the one repository. Metrics is the expensive one and it is also
  // the one that makes the row rankable at all, so it is not optional here.
  console.log(`Pulling issues, measuring maintainers, reading setup...\n`);
  const issues = await syncIssues({ repo: added.fullName });
  const metrics = await syncMetrics({ repo: added.fullName, staleDays: 0 });
  const setup = await syncSetup({ repo: added.fullName, staleDays: 0 });

  console.log(
    `\n${added.fullName} is ready. See it with:\n` +
      `  npm run compass -- shortlist --min-score 0\n`,
  );

  return { repo: added, issues, metrics, setup };
}
