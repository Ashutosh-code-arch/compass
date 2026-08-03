import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Kind, buildSchema, parse, validate, type OperationDefinitionNode } from 'graphql';
import { buildSetupQuery, mapSetupRepository, type GqlSetupRepository } from './setup_query.ts';

/** Trimmed stand-in for the parts of GitHub's schema this query touches. */
const SCHEMA = buildSchema(`
  type TreeEntry { name: String!, type: String! }
  type Tree implements GitObject { id: ID, entries: [TreeEntry!] }
  type Blob implements GitObject { id: ID, text: String, isTruncated: Boolean }
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
  assert.equal(declared.size, 6, 'two variables per repository, no strays');

  // Alias collisions would silently overwrite one file's contents with another's.
  const aliases = [...buildSetupQuery(1).matchAll(/^\s{2}(\w+): object\(/gm)].map((match) => match[1]);
  assert.equal(new Set(aliases).size, aliases.length, `duplicate alias in ${aliases.join(',')}`);
  assert.ok(aliases.length > 15, 'expected a blob alias per candidate file');
});

// ---------------------------------------------------------------------------
// mapping
// ---------------------------------------------------------------------------

function repository(overrides: Partial<GqlSetupRepository> = {}): GqlSetupRepository {
  return {
    nameWithOwner: 'owner/name',
    root: { entries: [{ name: 'README.md', type: 'blob' }] },
    workflows: null,
    devcontainer: null,
    ...overrides,
  };
}

test('compose candidates resolve in spec order', () => {
  const facts = mapSetupRepository(
    repository({
      compose_compose_yaml: { text: 'services:\n  a:\n    image: redis:7\n' },
      compose_docker_compose_yml: { text: 'services:\n  x:\n    image: postgres:16\n  y:\n    image: postgres:16\n' },
    }),
  );
  assert.equal(facts.composePath, 'compose.yaml', 'compose.yaml wins over docker-compose.yml');
  assert.equal(facts.composeServices, 1);
});

test('a truncated blob is discarded rather than miscounted', () => {
  const facts = mapSetupRepository(
    repository({
      compose_docker_compose_yml: {
        text: 'services:\n  only_the_first:\n    image: postgres:16\n',
        isTruncated: true,
      },
    }),
  );
  assert.equal(facts.composePath, null, 'a partial file would give a wrong service count');
});

test('an unreadable root tree is reported as truncated, not as a simple repo', () => {
  const facts = mapSetupRepository(repository({ root: null }));
  assert.equal(facts.treeTruncated, true);
  assert.equal(facts.filesSeen, 0);
  assert.equal(facts.setupWeight, 'unknown', 'no evidence is not evidence of simplicity');
});

test('runtimes, env vars and workflows map through', () => {
  const facts = mapSetupRepository(
    repository({
      root: {
        entries: [
          { name: 'README.md', type: 'blob' },
          { name: 'package.json', type: 'blob' },
          { name: 'pnpm-lock.yaml', type: 'blob' },
          { name: 'Makefile', type: 'blob' },
        ],
      },
      workflows: { entries: [{ name: 'ci.yml' }, { name: 'release.yml' }] },
      devcontainer: { entries: [{ name: 'devcontainer.json' }] },
      packageJson: { text: JSON.stringify({ engines: { node: '>=22' } }) },
      env__env_example: { text: 'A=\nB=\n# comment\nC=1\n' },
      wf_ci_yml: { text: 'on:\n  pull_request:\njobs: {}\n' },
    }),
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

test('a repo with no recognised files yields nulls, not zeros', () => {
  const facts = mapSetupRepository(repository());
  assert.equal(facts.composeServices, null);
  assert.equal(facts.envVarCount, null);
  assert.equal(facts.ciRunsOnPr, null);
  assert.equal(facts.ciWorkflowCount, 0);
  assert.deepEqual(facts.runtimes, []);
  assert.equal(facts.setupWeight, 'light', 'one README is genuinely light, not unknown');
});
