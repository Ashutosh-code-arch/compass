/**
 * The whole file tree, not just the root.
 *
 * The bug this fixes: setup complexity was read from root-level files only, so a project keeping its
 * compose file in `build/` or its env template in `config/` reported as `light` when it was not.
 * `mattermost/mattermost` read as `light`. It is not light, and a tool whose job is to warn you off
 * expensive setups was giving exactly the wrong answer for the expensive ones.
 *
 * One REST request per repository gets the full tree with a `truncated` flag, which is cheaper and
 * more complete than walking directories in GraphQL. The classification below is PURE, so the rules
 * about which paths count are testable without a network.
 *
 * Deliberately narrow in scope: only **compose files and env templates** are searched at depth. Every
 * other fact — Makefile, README, CONTRIBUTING, lockfiles — is still read from the root, because those
 * conventionally live there and widening the search would change existing verdicts for reasons
 * unrelated to the bug. A fix that quietly re-scores the whole corpus is not a fix.
 */

import type { GitHubRest } from '../github/rest.ts';

/** Compose filenames, in the order the Compose spec resolves them. */
const COMPOSE_NAMES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];

const ENV_NAMES = ['.env.example', '.env.sample', '.env.template', 'env.example', '.env.dist'];

/**
 * Directories whose contents describe something other than this project's own setup.
 *
 * A compose file inside `node_modules` or a vendored dependency is not how you run the project, and an
 * example app's compose file under `examples/` is not either. Including them made a simple project
 * look complicated, which is the same class of error in the opposite direction.
 */
const IGNORED_SEGMENTS = new Set([
  'node_modules',
  'vendor',
  'third_party',
  'thirdparty',
  'testdata',
  'fixtures',
  'examples',
  'example',
  'samples',
  'demo',
  'demos',
  'docs',
  'website',
  'site',
  '.git',
  'dist',
  'build-output',
  'target',
  '__pycache__',
]);

export interface TreeEntry {
  path: string;
  type: 'blob' | 'tree' | string;
}

export interface RepoTree {
  entries: TreeEntry[];
  /** GitHub stopped listing. Any "not found" conclusion from a truncated tree is unsafe. */
  truncated: boolean;
}

export function depthOf(path: string): number {
  return path.split('/').length - 1;
}

function isIgnored(path: string): boolean {
  const segments = path.split('/');
  // The final segment is the filename; only directories are judged.
  return segments.slice(0, -1).some((segment) => IGNORED_SEGMENTS.has(segment.toLowerCase()));
}

/** Root-level entry names, so root-derived facts keep their previous meaning exactly. */
export function rootNames(tree: RepoTree): string[] {
  return tree.entries.filter((entry) => depthOf(entry.path) === 0).map((entry) => entry.path);
}

/**
 * Finds one file by conventional name, anywhere sensible, preferring the shallowest.
 *
 * Shallowest wins because that is the one a human would run. Ties break on the order of `names`,
 * which for compose files is the spec's own resolution order.
 */
export function findByName(tree: RepoTree, names: string[]): { path: string; depth: number } | null {
  let best: { path: string; depth: number; rank: number } | null = null;

  for (const entry of tree.entries) {
    if (entry.type !== 'blob') continue;
    if (isIgnored(entry.path)) continue;
    const base = entry.path.split('/').pop()!.toLowerCase();
    const rank = names.findIndex((name) => name.toLowerCase() === base);
    if (rank === -1) continue;

    const depth = depthOf(entry.path);
    if (best === null || depth < best.depth || (depth === best.depth && rank < best.rank)) {
      best = { path: entry.path, depth, rank };
    }
  }

  return best ? { path: best.path, depth: best.depth } : null;
}

export function findCompose(tree: RepoTree): { path: string; depth: number } | null {
  return findByName(tree, COMPOSE_NAMES);
}

export function findEnvTemplate(tree: RepoTree): { path: string; depth: number } | null {
  return findByName(tree, ENV_NAMES);
}

/** A Dockerfile anywhere that is not vendored still means containers are involved. */
export function hasDockerfileAnywhere(tree: RepoTree): boolean {
  return tree.entries.some(
    (entry) =>
      entry.type === 'blob' &&
      !isIgnored(entry.path) &&
      entry.path.split('/').pop()!.toLowerCase().startsWith('dockerfile'),
  );
}

export function hasDevcontainerAnywhere(tree: RepoTree): boolean {
  return tree.entries.some((entry) => entry.path.toLowerCase().includes('.devcontainer'));
}

/** Workflow files, so CI detection no longer depends on conventional filenames. */
export function workflowPaths(tree: RepoTree): string[] {
  return tree.entries
    .filter(
      (entry) =>
        entry.type === 'blob' &&
        /^\.github\/workflows\/.+\.(ya?ml)$/i.test(entry.path),
    )
    .map((entry) => entry.path)
    .sort();
}

/**
 * Manifest paths, root first.
 *
 * A monorepo has many `package.json` files and the root one is the one describing the project. Nested
 * ones are returned after it so a workspace-only repo still yields something to read.
 */
export function manifestPaths(tree: RepoTree, filename: string): string[] {
  return tree.entries
    .filter(
      (entry) =>
        entry.type === 'blob' &&
        !isIgnored(entry.path) &&
        entry.path.split('/').pop()!.toLowerCase() === filename.toLowerCase(),
    )
    .map((entry) => entry.path)
    .sort((a, b) => depthOf(a) - depthOf(b) || a.localeCompare(b));
}

interface GhTreeResponse {
  tree?: { path?: string; type?: string }[];
  truncated?: boolean;
}

/**
 * One request for the whole tree.
 *
 * `truncated` matters and is carried through rather than ignored: on a very large repository GitHub
 * stops listing, and concluding "no compose file" from a partial tree would reintroduce the same class
 * of wrong answer this change exists to remove.
 */
export async function fetchTree(
  gh: GitHubRest,
  owner: string,
  name: string,
  branch: string,
): Promise<RepoTree | null> {
  const result = await gh.get<GhTreeResponse>(
    `/repos/${owner}/${name}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
  );
  if (!result.data) return null;

  const entries: TreeEntry[] = (result.data.tree ?? [])
    .filter((entry): entry is { path: string; type: string } => typeof entry.path === 'string')
    .map((entry) => ({ path: entry.path, type: entry.type ?? 'blob' }));

  return { entries, truncated: result.data.truncated === true };
}
