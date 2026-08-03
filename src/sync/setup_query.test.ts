import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Kind, buildSchema, parse, validate, type OperationDefinitionNode } from 'graphql';
import {
  BLOB_ROLES,
  blobVariables,
  buildSetupQuery,
  mapSetupRepository,
  type GqlSetupRepository,
} from './setup_query.ts';
import type { RepoTree } from './tree.ts';

/** Trimmed stand-in for the parts of GitHub's schema this query touches. */
const SCHEMA = buildSchema(`
  type Blob implements GitObject { id: ID, text: String, isTruncated: Boolean }
  type Tree implements GitObject { id: ID }
  interface GitObject { id: ID }
  type Repository {
    nameWithOwner: String!
    object(expression: String): GitObject
  }
  type RateLimit { limit: Int!, cost: Int!, remaining: Int!, resetAt: String! }
  type Query {
    rateLimit: RateLimit
    repository(owner: String!, name: String!): Repository
  }
`);

function tree(paths: string[], truncated = false): RepoTree {
  return { entries: paths.map((path) => ({ path, type: 'blob' })), truncated };
}

// ---------------------------------------------------------------------------
// the query
// ---------------------------------------------------------------------------

test('the generated setup query is valid GraphQL for every batch size', () => {
  for (const batchSize of [1, 2, 3, 5, 10]) {
    const errors = validate(SCHEMA, parse(buildSetupQuery(batchSize)));
    assert.deepEqual(errors.map((error) => error.message), [], `batch size ${batchSize}`);
  }
});

test('aliases are unique and every variable is declared', () => {
  const document = parse(buildSetupQuery(3));
  const operation = document.definitions.find(
    (definition): definition is OperationDefinitionNode =>
      definition.kind === Kind.OPERATION_DEFINITION,
  );
  assert.ok(operation);
  const declared = new Set(
    operation.variableDefinitions?.map((definition) => definition.variable.name.value) ?? [],
  );
  // owner + name + one expression per blob role, per repository.
  assert.equal(declared.size, 3 * (2 + BLOB_ROLES.length));

  // Alias collisions would silently overwrite one file's contents with another's.
  const aliases = [...buildSetupQuery(1).matchAll(/^\s+(\w+): object\(/gm)].map((m) => m[1]);
  assert.equal(new Set(aliases).size, aliases.length, `duplicate alias in ${aliases.join(',')}`);
  assert.equal(aliases.length, BLOB_ROLES.length);
});

test('every declared variable is supplied for a repository, so none arrives null', () => {
  // A missing variable is a GraphQL error for the whole query, taking the rest of the batch with it.
  const variables = blobVariables(0, tree(['README.md']));
  for (const role of BLOB_ROLES) {
    assert.ok(`e0_${role}` in variables, `no value for ${role}`);
    assert.equal(typeof variables[`e0_${role}`], 'string');
  }
});

test('an absent file becomes an expression that is deliberately not a blob', () => {
  const variables = blobVariables(0, tree(['README.md']));
  // HEAD: resolves to a Tree, so `... on Blob` yields null without needing a conditional query.
  assert.equal(variables['e0_compose'], 'HEAD:');
  assert.equal(variables['e0_packageJson'], 'HEAD:');
});

test('discovered paths are requested wherever they actually live', () => {
  // The whole point of the change: a compose file outside the root used to be invisible.
  const variables = blobVariables(0, tree(['build/docker-compose.yml', 'config/.env.example']));
  assert.equal(variables['e0_compose'], 'HEAD:build/docker-compose.yml');
  assert.equal(variables['e0_env'], 'HEAD:config/.env.example');
});

// ---------------------------------------------------------------------------
// mapping
// ---------------------------------------------------------------------------

function repository(overrides: Partial<GqlSetupRepository> = {}): GqlSetupRepository {
  return { nameWithOwner: 'owner/name', ...overrides };
}

test('a nested compose file is found and its depth recorded', () => {
  // mattermost/mattermost read as `light` because its compose file is not at the root. This is that
  // case: the tool must not report a seven-service project as simple.
  const facts = mapSetupRepository(
    repository({
      compose: { text: 'services:\n  a:\n    image: postgres:16\n  b:\n    image: redis:7\n' },
    }),
    tree(['README.md', 'build/docker-compose.yml']),
  );
  assert.equal(facts.composePath, 'build/docker-compose.yml');
  assert.equal(facts.composeServices, 2);
  assert.equal(facts.composeDepth, 1, 'depth is what proves the root-only bug cannot return silently');
});

test('the shallowest compose file wins, then spec order', () => {
  const facts = mapSetupRepository(
    repository({ compose: { text: 'services:\n  a:\n    image: redis:7\n' } }),
    tree(['compose.yaml', 'deploy/prod/docker-compose.yml']),
  );
  assert.equal(facts.composePath, 'compose.yaml');
  assert.equal(facts.composeDepth, 0);
});

test('a truncated blob is discarded rather than miscounted', () => {
  const facts = mapSetupRepository(
    repository({
      compose: { text: 'services:\n  only_the_first:\n    image: postgres:16\n', isTruncated: true },
    }),
    tree(['docker-compose.yml']),
  );
  assert.equal(facts.composePath, null, 'a partial file would give a wrong service count');
});

test('an empty tree is reported as truncated, not as a simple repo', () => {
  const facts = mapSetupRepository(repository(), tree([]));
  assert.equal(facts.treeTruncated, true);
  assert.equal(facts.setupWeight, 'unknown', 'no evidence is not evidence of simplicity');
});

test('a truncated tree stays unknown even when files were seen', () => {
  // GitHub stopped listing, so "no compose file" is not a finding.
  const facts = mapSetupRepository(repository(), tree(['README.md', 'src/a.ts'], true));
  assert.equal(facts.treeTruncated, true);
  assert.equal(facts.setupWeight, 'unknown');
});

test('root-level facts still come from the root only', () => {
  // Widening these would re-score the corpus for reasons unrelated to the bug being fixed.
  const facts = mapSetupRepository(
    repository(),
    tree(['README.md', 'tools/Makefile', 'sub/pnpm-lock.yaml']),
  );
  assert.equal(facts.taskRunner, 'none', 'a Makefile in tools/ is not how you build the project');
  assert.equal(facts.packageManager, null);
});

test('a Dockerfile anywhere counts, because containers are involved either way', () => {
  const facts = mapSetupRepository(repository(), tree(['README.md', 'docker/Dockerfile.dev']));
  assert.equal(facts.hasDockerfile, true);
});

test('runtimes, env vars and workflows map through', () => {
  const facts = mapSetupRepository(
    repository({
      packageJson: { text: JSON.stringify({ engines: { node: '>=22' } }) },
      env: { text: 'A=\nB=\n# comment\nC=1\n' },
      workflow0: { text: 'on:\n  pull_request:\njobs: {}\n' },
    }),
    tree([
      'README.md',
      'package.json',
      'pnpm-lock.yaml',
      'Makefile',
      '.env.example',
      '.github/workflows/ci.yml',
      '.github/workflows/release.yml',
      '.devcontainer/devcontainer.json',
    ]),
  );

  assert.deepEqual(facts.runtimes, [{ name: 'node', constraint: '>=22', source: 'package.json' }]);
  assert.equal(facts.envVarCount, 3);
  assert.equal(facts.envExamplePath, '.env.example');
  assert.equal(facts.packageManager, 'pnpm');
  assert.equal(facts.taskRunner, 'make');
  assert.equal(facts.hasDevcontainer, true);
  assert.equal(facts.ciWorkflowCount, 2);
  assert.equal(facts.ciRunsOnPr, true);
});

test('workflow detection no longer depends on conventional filenames', () => {
  // Previously only ci.yml, test.yml, main.yml and build.yml were read.
  const facts = mapSetupRepository(
    repository({ workflow0: { text: 'on:\n  pull_request:\njobs: {}\n' } }),
    tree(['README.md', '.github/workflows/unusual-name.yaml']),
  );
  assert.equal(facts.ciWorkflowCount, 1);
  assert.equal(facts.ciRunsOnPr, true);
});

test('the file count reports the whole tree, and the root count is kept', () => {
  const facts = mapSetupRepository(
    repository(),
    tree(['README.md', 'src/a.ts', 'src/b.ts', 'test/c.ts']),
  );
  assert.equal(facts.filesSeen, 4);
  assert.equal(facts.rootFilesSeen, 1, 'kept so the improvement is measurable, not asserted');
});

test('frameworks are detected from the manifest already being fetched', () => {
  const facts = mapSetupRepository(
    repository({
      packageJson: { text: JSON.stringify({ dependencies: { react: '^18', next: '^14' } }) },
    }),
    tree(['package.json']),
  );
  assert.deepEqual(facts.frameworks, ['nextjs', 'react']);
});

test('topics contribute frameworks when the manifest cannot be read', () => {
  const facts = mapSetupRepository(repository(), tree(['README.md']), ['react', 'not-a-framework']);
  assert.deepEqual(facts.frameworks, ['react'], 'a topic must not invent a stack outside the vocabulary');
});

test('a repo with no recognised files yields nulls, not zeros', () => {
  const facts = mapSetupRepository(repository(), tree(['README.md']));
  assert.equal(facts.composeServices, null);
  assert.equal(facts.envVarCount, null);
  assert.equal(facts.ciRunsOnPr, null);
  assert.equal(facts.ciWorkflowCount, 0);
  assert.deepEqual(facts.runtimes, []);
  assert.deepEqual(facts.frameworks, []);
  assert.equal(facts.setupWeight, 'light', 'one README is genuinely light, not unknown');
});
