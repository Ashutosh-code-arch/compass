import { RATE_LIMIT_FRAGMENT } from '../github/graphql.ts';
import { assembleSetupFacts, parseCompose, type SetupFacts } from '../setup/parse.ts';

/**
 * Compose filenames in the order the Compose spec resolves them.
 */
const COMPOSE_CANDIDATES = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
];

const ENV_CANDIDATES = ['.env.example', '.env.sample', '.env.template', 'env.example'];

/**
 * Conventional workflow filenames. CI in an unusually named file leaves ci_runs_on_pr undetermined
 * rather than false — see ciRunsOnPullRequest.
 */
const WORKFLOW_CANDIDATES = ['ci.yml', 'ci.yaml', 'test.yml', 'main.yml', 'build.yml'];

/** Alias-safe key: GraphQL aliases must match /[_A-Za-z][_0-9A-Za-z]*​/. */
function aliasFor(prefix: string, path: string): string {
  return `${prefix}_${path.replace(/[^0-9A-Za-z]/g, '_')}`;
}

function blobField(alias: string, path: string): string {
  return `  ${alias}: object(expression: "HEAD:${path}") { ... on Blob { text isTruncated } }`;
}

/**
 * One query covers several repositories via aliases.
 *
 * Everything is read at the default branch HEAD. The root tree gives presence for every top-level
 * file in a single field, so blob text is only requested for files whose *contents* are parsed —
 * presence alone never costs a fetch.
 */
export function buildSetupQuery(batchSize: number): string {
  const declarations: string[] = [];
  const aliases: string[] = [];

  for (let index = 0; index < batchSize; index += 1) {
    declarations.push(`$o${index}: String!`, `$n${index}: String!`);
    aliases.push(`  r${index}: repository(owner: $o${index}, name: $n${index}) { ...RepoSetup }`);
  }

  const blobs = [
    ...COMPOSE_CANDIDATES.map((path) => blobField(aliasFor('compose', path), path)),
    ...ENV_CANDIDATES.map((path) => blobField(aliasFor('env', path), path)),
    ...WORKFLOW_CANDIDATES.map((path) =>
      blobField(aliasFor('wf', path), `.github/workflows/${path}`),
    ),
    blobField('packageJson', 'package.json'),
    blobField('nvmrc', '.nvmrc'),
    blobField('toolVersions', '.tool-versions'),
    blobField('pyproject', 'pyproject.toml'),
    blobField('goMod', 'go.mod'),
    blobField('cargoToml', 'Cargo.toml'),
    blobField('pomXml', 'pom.xml'),
  ];

  return `query SetupFacts(${declarations.join(', ')}) {
  ${RATE_LIMIT_FRAGMENT}
${aliases.join('\n')}
}

fragment RepoSetup on Repository {
  nameWithOwner
  root: object(expression: "HEAD:") {
    ... on Tree { entries { name type } }
  }
  workflows: object(expression: "HEAD:.github/workflows") {
    ... on Tree { entries { name } }
  }
  devcontainer: object(expression: "HEAD:.devcontainer") {
    ... on Tree { entries { name } }
  }
${blobs.join('\n')}
}`;
}

interface GqlBlob {
  text?: string | null;
  isTruncated?: boolean | null;
}

interface GqlTreeEntry {
  name: string;
  type?: string;
}

export interface GqlSetupRepository {
  nameWithOwner: string;
  root?: { entries?: (GqlTreeEntry | null)[] | null } | null;
  workflows?: { entries?: (GqlTreeEntry | null)[] | null } | null;
  devcontainer?: { entries?: (GqlTreeEntry | null)[] | null } | null;
  [alias: string]: unknown;
}

function blob(repository: GqlSetupRepository, alias: string): string | null {
  const value = repository[alias] as GqlBlob | null | undefined;
  if (!value || typeof value.text !== 'string') return null;
  // A truncated blob would give a misleading service or variable count.
  if (value.isTruncated) return null;
  return value.text;
}

function entryNames(
  container: { entries?: (GqlTreeEntry | null)[] | null } | null | undefined,
): string[] {
  return (container?.entries ?? [])
    .filter((entry): entry is GqlTreeEntry => entry !== null)
    .map((entry) => entry.name);
}

export function mapSetupRepository(repository: GqlSetupRepository): SetupFacts {
  // First compose candidate that is present, in spec resolution order.
  let compose = null;
  for (const path of COMPOSE_CANDIDATES) {
    const text = blob(repository, aliasFor('compose', path));
    if (text) {
      compose = parseCompose(path, text);
      if (compose) break;
    }
  }

  const treeNames = entryNames(repository.root);

  return assembleSetupFacts({
    treeNames,
    // An absent root tree means the query could not see the repository contents at all.
    treeTruncated: treeNames.length === 0,
    compose,
    runtimeSources: {
      packageJson: blob(repository, 'packageJson'),
      nvmrc: blob(repository, 'nvmrc'),
      toolVersions: blob(repository, 'toolVersions'),
      pyproject: blob(repository, 'pyproject'),
      goMod: blob(repository, 'goMod'),
      cargoToml: blob(repository, 'cargoToml'),
      pomXml: blob(repository, 'pomXml'),
    },
    envFiles: ENV_CANDIDATES.map((path) => ({ path, text: blob(repository, aliasFor('env', path)) })),
    workflowNames: entryNames(repository.workflows),
    workflowTexts: WORKFLOW_CANDIDATES.map((path) => blob(repository, aliasFor('wf', path))),
    devcontainerNames: entryNames(repository.devcontainer),
  });
}
