/**
 * Blob fetching for setup facts, at paths discovered from the full tree.
 *
 * Previously the paths were hardcoded to the repository root, which is the bug in `tree.ts`'s header
 * comment. Now `src/sync/tree.ts` finds where things actually are, and this requests those paths.
 *
 * The query shape stays static so batching still works: each repository gets a fixed number of blob
 * slots, and the paths arrive as GraphQL variables. An empty slot is sent as `HEAD:`, which resolves to
 * a Tree rather than a Blob, so `... on Blob` yields null and no conditional query is needed.
 */

import { RATE_LIMIT_FRAGMENT } from '../github/graphql.ts';
import { detectContributorAgreement, type ContributorAgreement } from '../setup/agreement.ts';
import { assembleSetupFacts, parseCompose, type SetupFacts } from '../setup/parse.ts';
import { detectStacks } from '../setup/stack.ts';
import {
  findCompose,
  findContributing,
  findEnvTemplate,
  hasDevcontainerAnywhere,
  hasDockerfileAnywhere,
  manifestPaths,
  rootNames,
  workflowPaths,
  type RepoTree,
} from './tree.ts';

/**
 * The files whose *contents* are parsed. Presence-only facts come from the tree and cost nothing.
 *
 * Fixed order, because the slot index is part of the variable name.
 */
export const BLOB_ROLES = [
  'compose',
  'env',
  // Added for CLA/DCO detection. One more slot in a request that was already being made, which is
  // why the whole feature costs nothing measurable.
  'contributing',
  'packageJson',
  'nvmrc',
  'toolVersions',
  'pyproject',
  'requirementsTxt',
  'goMod',
  'cargoToml',
  'pomXml',
  'workflow0',
  'workflow1',
  'workflow2',
] as const;

export type BlobRole = (typeof BLOB_ROLES)[number];

/** How many workflow files are read. Three is enough to find one that triggers on pull_request. */
const WORKFLOW_SLOTS = 3;

/** An expression that is deliberately not a blob, for unused slots. */
const NO_FILE = 'HEAD:';

export function buildSetupQuery(batchSize: number): string {
  const declarations: string[] = [];
  const aliases: string[] = [];

  for (let index = 0; index < batchSize; index += 1) {
    declarations.push(`$o${index}: String!`, `$n${index}: String!`);
    for (const role of BLOB_ROLES) declarations.push(`$e${index}_${role}: String!`);

    const blobs = BLOB_ROLES.map(
      (role) =>
        `      ${role}: object(expression: $e${index}_${role}) { ... on Blob { text isTruncated } }`,
    ).join('\n');

    aliases.push(
      `  r${index}: repository(owner: $o${index}, name: $n${index}) {\n` +
        `    nameWithOwner\n${blobs}\n  }`,
    );
  }

  return `query SetupFacts(${declarations.join(', ')}) {
  ${RATE_LIMIT_FRAGMENT}
${aliases.join('\n')}
}`;
}

/**
 * The variables for one repository's slots, derived from its tree.
 *
 * Kept separate from the fetch so the mapping from a tree to a set of paths is testable.
 */
export function blobVariables(index: number, tree: RepoTree): Record<string, string> {
  const first = (paths: string[]): string | null => paths[0] ?? null;
  const workflows = workflowPaths(tree).slice(0, WORKFLOW_SLOTS);

  const paths: Record<BlobRole, string | null> = {
    compose: findCompose(tree)?.path ?? null,
    env: findEnvTemplate(tree)?.path ?? null,
    contributing: findContributing(tree)?.path ?? null,
    packageJson: first(manifestPaths(tree, 'package.json')),
    nvmrc: first(manifestPaths(tree, '.nvmrc')),
    toolVersions: first(manifestPaths(tree, '.tool-versions')),
    pyproject: first(manifestPaths(tree, 'pyproject.toml')),
    requirementsTxt: first(manifestPaths(tree, 'requirements.txt')),
    goMod: first(manifestPaths(tree, 'go.mod')),
    cargoToml: first(manifestPaths(tree, 'Cargo.toml')),
    pomXml: first(manifestPaths(tree, 'pom.xml')),
    workflow0: workflows[0] ?? null,
    workflow1: workflows[1] ?? null,
    workflow2: workflows[2] ?? null,
  };

  const variables: Record<string, string> = {};
  for (const role of BLOB_ROLES) {
    variables[`e${index}_${role}`] = paths[role] ? `HEAD:${paths[role]}` : NO_FILE;
  }
  return variables;
}

interface GqlBlob {
  text?: string | null;
  isTruncated?: boolean | null;
}

export interface GqlSetupRepository {
  nameWithOwner: string;
  [role: string]: unknown;
}

function blob(repository: GqlSetupRepository, role: BlobRole): string | null {
  const value = repository[role] as GqlBlob | null | undefined;
  if (!value || typeof value.text !== 'string') return null;
  // A truncated blob would give a misleading service or variable count.
  if (value.isTruncated) return null;
  return value.text;
}

/**
 * Assembles the facts for one repository from its tree and its fetched blobs.
 *
 * Root-derived facts are still computed from root-level names only, so this change does not re-score
 * the corpus for reasons unrelated to the bug. Nested findings are folded in additively: a Dockerfile
 * or devcontainer anywhere counts, and the compose and env files are wherever they were found.
 */
export function mapSetupRepository(
  repository: GqlSetupRepository,
  tree: RepoTree,
  topics: string[] = [],
): SetupFacts & {
  frameworks: string[];
  composeDepth: number | null;
  envDepth: number | null;
  rootFilesSeen: number;
  contributorAgreement: ContributorAgreement | null;
  agreementEvidence: string[];
  contributingPath: string | null;
} {
  const composeFound = findCompose(tree);
  const envFound = findEnvTemplate(tree);
  const contributingFound = findContributing(tree);
  const composeText = blob(repository, 'compose');
  const compose = composeFound && composeText ? parseCompose(composeFound.path, composeText) : null;

  const root = rootNames(tree);
  const runtimeSources = {
    packageJson: blob(repository, 'packageJson'),
    nvmrc: blob(repository, 'nvmrc'),
    toolVersions: blob(repository, 'toolVersions'),
    pyproject: blob(repository, 'pyproject'),
    goMod: blob(repository, 'goMod'),
    cargoToml: blob(repository, 'cargoToml'),
    pomXml: blob(repository, 'pomXml'),
  };

  const facts = assembleSetupFacts({
    treeNames: root,
    // Truncation is a property of the listing, not of the root. Carried through so a partial tree
    // never reads as a confident "nothing here".
    treeTruncated: tree.truncated || tree.entries.length === 0,
    compose,
    runtimeSources,
    envFiles: envFound ? [{ path: envFound.path, text: blob(repository, 'env') }] : [],
    workflowNames: workflowPaths(tree).map((path) => path.split('/').pop()!),
    workflowTexts: [
      blob(repository, 'workflow0'),
      blob(repository, 'workflow1'),
      blob(repository, 'workflow2'),
    ],
    devcontainerNames: [],
  });

  // A truncated tree is passed through rather than hidden: positive findings still stand, but the
  // "nothing required" verdict has to be withheld, and only the detector can make that distinction.
  const agreement = detectContributorAgreement({
    contributingText: blob(repository, 'contributing'),
    treePaths: tree.entries.map((entry) => entry.path),
    treeTruncated: tree.truncated,
  });

  return {
    ...facts,
    // The whole tree is the honest file count; the root count is kept so the change is measurable.
    filesSeen: tree.entries.length,
    rootFilesSeen: root.length,
    hasDockerfile: facts.hasDockerfile || hasDockerfileAnywhere(tree),
    hasDevcontainer: facts.hasDevcontainer || hasDevcontainerAnywhere(tree),
    frameworks: detectStacks(
      { ...runtimeSources, requirementsTxt: blob(repository, 'requirementsTxt') },
      topics,
    ),
    composeDepth: composeFound?.depth ?? null,
    envDepth: envFound?.depth ?? null,
    contributorAgreement: agreement.agreement,
    agreementEvidence: agreement.evidence,
    contributingPath: contributingFound?.path ?? null,
  };
}
