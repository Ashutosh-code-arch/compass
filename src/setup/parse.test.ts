import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assembleSetupFacts,
  ciRunsOnPullRequest,
  classifySetupWeight,
  countEnvVars,
  declaredPackageManager,
  hasWorkspaces,
  parseCompose,
  parseRuntimes,
  parseTree,
} from './parse.ts';

// ---------------------------------------------------------------------------
// docker compose
// ---------------------------------------------------------------------------

const REAL_COMPOSE = `
version: "3.8"
services:
  web:
    build: .
    ports: ["3000:3000"]
    depends_on: [db, redis]
  worker:
    build:
      context: .
      dockerfile: Dockerfile.worker
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_PASSWORD: dev
  redis:
    image: docker.io/library/redis:7
  broker:
    image: confluentinc/cp-kafka:7.5.0
  zk:
    image: confluentinc/cp-zookeeper:7.5.0
  mail:
    image: axllent/mailpit
`;

test('compose services are counted and backing services identified', () => {
  const facts = parseCompose('docker-compose.yml', REAL_COMPOSE);
  assert.ok(facts);
  assert.equal(facts.services, 7);
  assert.deepEqual(facts.serviceNames, ['web', 'worker', 'db', 'redis', 'broker', 'zk', 'mail']);
  assert.equal(facts.buildsLocal, true, 'both string and object build forms count');
  assert.deepEqual(facts.externalServices, ['kafka', 'mail', 'postgres', 'redis', 'zookeeper']);
});

test('registry prefixes and tags do not defeat image matching', () => {
  const facts = parseCompose('compose.yaml', `
services:
  a:
    image: docker.io/bitnami/postgresql:16.2.0-debian-12-r8
  b:
    image: public.ecr.aws/docker/library/redis:7.2@sha256:abc
  c:
    image: mariadb:11
`);
  assert.ok(facts);
  assert.deepEqual(facts.externalServices, ['mysql', 'postgres', 'redis']);
});

test('a pull-only compose file reports buildsLocal false', () => {
  const facts = parseCompose('docker-compose.yml', `
services:
  app:
    image: ghcr.io/example/app:latest
`);
  assert.ok(facts);
  assert.equal(facts.buildsLocal, false);
  assert.equal(facts.services, 1);
});

test('absent, empty and malformed compose files yield null rather than invented facts', () => {
  assert.equal(parseCompose('docker-compose.yml', null), null);
  assert.equal(parseCompose('docker-compose.yml', ''), null);
  assert.equal(parseCompose('docker-compose.yml', '   \n  '), null);
  // Templated YAML is common and is not parseable.
  assert.equal(parseCompose('docker-compose.yml', 'services:\n  a:\n   image: {{ .Values.img }\n  ['), null);
  // Valid YAML, but no services key.
  assert.equal(parseCompose('docker-compose.yml', 'version: "3"\nvolumes:\n  data:\n'), null);
});

// ---------------------------------------------------------------------------
// runtimes
// ---------------------------------------------------------------------------

test('runtime constraints are read from each ecosystem', () => {
  const runtimes = parseRuntimes({
    packageJson: JSON.stringify({ engines: { node: '>=22.9' } }),
    pyproject: '[project]\nname = "x"\nrequires-python = ">=3.11,<3.14"\n',
    goMod: 'module example.com/x\n\ngo 1.23.4\n\nrequire (\n)\n',
    cargoToml: '[package]\nname = "x"\nrust-version = "1.78"\n',
    pomXml: '<project><properties><maven.compiler.release>21</maven.compiler.release></properties></project>',
  });
  assert.deepEqual(
    runtimes.map((runtime) => [runtime.name, runtime.constraint]),
    [['node', '>=22.9'], ['python', '>=3.11,<3.14'], ['go', '1.23.4'], ['rust', '1.78'], ['java', '21']],
  );
});

test('package.json engines wins over .nvmrc, and the v prefix is stripped', () => {
  const fromNvmrc = parseRuntimes({ nvmrc: 'v20.11.1\n' });
  assert.deepEqual(fromNvmrc, [{ name: 'node', constraint: '20.11.1', source: '.nvmrc' }]);

  const both = parseRuntimes({
    packageJson: JSON.stringify({ engines: { node: '22.x' } }),
    nvmrc: 'v20.11.1',
  });
  assert.equal(both.length, 1);
  assert.equal(both[0]?.source, 'package.json');
});

test('.tool-versions contributes several runtimes', () => {
  const runtimes = parseRuntimes({ toolVersions: 'nodejs 22.2.0\npython 3.12.1\n# comment\ngolang 1.23\n' });
  assert.deepEqual(runtimes.map((runtime) => runtime.name), ['nodejs', 'python', 'golang']);
});

test('malformed manifests do not throw', () => {
  assert.deepEqual(parseRuntimes({ packageJson: '{ not json' }), []);
  assert.deepEqual(parseRuntimes({ pyproject: 'nothing here' }), []);
  assert.deepEqual(parseRuntimes({}), []);
});

// ---------------------------------------------------------------------------
// env vars
// ---------------------------------------------------------------------------

test('env var counting ignores comments, blanks and prose', () => {
  const text = `# Database
DATABASE_URL=postgres://localhost/dev
REDIS_URL=

# Third party — you must obtain these yourself
STRIPE_SECRET_KEY=
export OPENAI_API_KEY=sk-...

#COMMENTED_OUT=1
  INDENTED_VAR=ok
not a variable line
`;
  assert.equal(countEnvVars(text), 5);
});

test('a missing env template is null, an empty one is zero', () => {
  assert.equal(countEnvVars(null), null);
  assert.equal(countEnvVars(undefined), null);
  assert.equal(countEnvVars(''), 0);
});

// ---------------------------------------------------------------------------
// tree
// ---------------------------------------------------------------------------

test('tree presence checks tolerate case and suffixes', () => {
  const tree = parseTree([
    'README.md', 'CONTRIBUTING.md', 'Dockerfile.dev', 'Makefile',
    'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.devcontainer', 'src',
  ]);
  assert.equal(tree.hasReadme, true);
  assert.equal(tree.hasContributing, true);
  assert.equal(tree.hasDockerfile, true, 'Dockerfile.dev counts');
  assert.equal(tree.hasDevcontainer, true);
  assert.equal(tree.taskRunner, 'make');
  assert.equal(tree.packageManager, 'pnpm');
  assert.equal(tree.isMonorepoByMarker, true);
});

test('task runners are detected in priority order', () => {
  assert.equal(parseTree(['Taskfile.yml']).taskRunner, 'task');
  assert.equal(parseTree(['justfile']).taskRunner, 'just');
  assert.equal(parseTree(['src', 'go.mod']).taskRunner, 'none');
});

test('an empty tree reports nothing present', () => {
  const tree = parseTree([]);
  assert.equal(tree.hasReadme, false);
  assert.equal(tree.packageManager, null);
});

test('declared packageManager beats lockfile inference', () => {
  assert.equal(declaredPackageManager(JSON.stringify({ packageManager: 'pnpm@9.1.0' })), 'pnpm');
  assert.equal(declaredPackageManager(JSON.stringify({})), null);
  assert.equal(declaredPackageManager('{ broken'), null);
});

test('workspaces are detected in both array and object form', () => {
  assert.equal(hasWorkspaces(JSON.stringify({ workspaces: ['packages/*'] })), true);
  assert.equal(hasWorkspaces(JSON.stringify({ workspaces: { packages: ['a'] } })), true);
  assert.equal(hasWorkspaces(JSON.stringify({ name: 'x' })), false);
  assert.equal(hasWorkspaces(null), false);
});

// ---------------------------------------------------------------------------
// CI
// ---------------------------------------------------------------------------

test('pull_request triggers are found in every YAML shape', () => {
  // `on` is the YAML 1.1 boolean true, so parsers may key it either way.
  assert.equal(ciRunsOnPullRequest(['on:\n  pull_request:\n    branches: [main]\njobs: {}\n']), true);
  assert.equal(ciRunsOnPullRequest(['on: [push, pull_request]\njobs: {}\n']), true);
  assert.equal(ciRunsOnPullRequest(['on: pull_request\njobs: {}\n']), true);
  assert.equal(ciRunsOnPullRequest(['on:\n  pull_request_target:\njobs: {}\n']), true);
});

test('a push-only workflow reports false, an unreadable one reports unknown', () => {
  assert.equal(ciRunsOnPullRequest(['on:\n  push:\n    branches: [main]\njobs: {}\n']), false);
  assert.equal(ciRunsOnPullRequest([null, undefined]), null, 'undetermined, not absent');
  assert.equal(ciRunsOnPullRequest([]), null);
  assert.equal(ciRunsOnPullRequest(['{{ template }}: [']), null, 'unparseable counts as unreadable');
});

// ---------------------------------------------------------------------------
// weight
// ---------------------------------------------------------------------------

const BARE = {
  treeTruncated: false,
  filesSeen: 12,
  composeServices: null,
  envVarCount: null,
  needsDatabase: false,
  needsQueue: false,
  externalServices: [],
  isMonorepo: false,
};

test('weight is light with no infrastructure at all', () => {
  assert.equal(classifySetupWeight(BARE), 'light');
});

test('an empty tree is unknown, not light', () => {
  assert.equal(classifySetupWeight({ ...BARE, filesSeen: 0 }), 'unknown');
});

test('service count drives weight', () => {
  assert.equal(classifySetupWeight({ ...BARE, composeServices: 1 }), 'light');
  assert.equal(classifySetupWeight({ ...BARE, composeServices: 3 }), 'moderate');
  assert.equal(classifySetupWeight({ ...BARE, composeServices: 7 }), 'heavy');
});

test('a database plus a queue is heavy however few services are declared', () => {
  assert.equal(
    classifySetupWeight({ ...BARE, needsDatabase: true, needsQueue: true, composeServices: 2 }),
    'heavy',
  );
  assert.equal(classifySetupWeight({ ...BARE, needsDatabase: true }), 'moderate');
});

test('configuration burden alone can make setup heavy', () => {
  assert.equal(classifySetupWeight({ ...BARE, envVarCount: 2 }), 'light');
  assert.equal(classifySetupWeight({ ...BARE, envVarCount: 6 }), 'moderate');
  assert.equal(classifySetupWeight({ ...BARE, envVarCount: 18 }), 'heavy');
});

test('a monorepo is at least moderate', () => {
  assert.equal(classifySetupWeight({ ...BARE, isMonorepo: true }), 'moderate');
});

// ---------------------------------------------------------------------------
// assembly
// ---------------------------------------------------------------------------

test('a realistic heavy project assembles end to end', () => {
  const facts = assembleSetupFacts({
    treeNames: ['README.md', 'CONTRIBUTING.md', 'Dockerfile', 'Makefile', 'docker-compose.yml',
      'package.json', 'pnpm-lock.yaml', '.env.example', '.github', 'src'],
    treeTruncated: false,
    compose: parseCompose('docker-compose.yml', REAL_COMPOSE),
    runtimeSources: {
      packageJson: JSON.stringify({ engines: { node: '>=22' }, packageManager: 'pnpm@9', workspaces: ['apps/*'] }),
    },
    envFiles: [
      { path: '.env.example', text: 'DATABASE_URL=\nREDIS_URL=\nKAFKA_BROKERS=\nSTRIPE_KEY=\nSENTRY_DSN=\n' },
      { path: '.env.sample', text: null },
    ],
    workflowNames: ['ci.yml', 'release.yaml', 'notes.md'],
    workflowTexts: ['on:\n  pull_request:\njobs: {}\n'],
    devcontainerNames: [],
  });

  assert.equal(facts.setupWeight, 'heavy');
  assert.equal(facts.composeServices, 7);
  assert.equal(facts.needsDatabase, true);
  assert.equal(facts.needsQueue, true);
  assert.equal(facts.needsCache, true);
  assert.equal(facts.envVarCount, 5);
  assert.equal(facts.envExamplePath, '.env.example', 'the first present template is used');
  assert.equal(facts.packageManager, 'pnpm');
  assert.equal(facts.isMonorepo, true);
  assert.equal(facts.taskRunner, 'make');
  assert.equal(facts.ciWorkflowCount, 2, 'only YAML files count as workflows');
  assert.equal(facts.ciRunsOnPr, true);
  assert.deepEqual(facts.runtimes, [{ name: 'node', constraint: '>=22', source: 'package.json' }]);
});

test('a plain library assembles as light with no invented facts', () => {
  const facts = assembleSetupFacts({
    treeNames: ['README.md', 'go.mod', 'go.sum', 'main.go'],
    treeTruncated: false,
    compose: null,
    runtimeSources: { goMod: 'module x\n\ngo 1.23\n' },
    envFiles: [{ path: '.env.example', text: null }],
    workflowNames: [],
    workflowTexts: [],
    devcontainerNames: [],
  });

  assert.equal(facts.setupWeight, 'light');
  assert.equal(facts.composePath, null);
  assert.equal(facts.composeServices, null, 'null, not 0 — no compose file was found');
  assert.equal(facts.envVarCount, null);
  assert.equal(facts.envExamplePath, null);
  assert.equal(facts.ciRunsOnPr, null, 'no workflows read, so undetermined');
  assert.equal(facts.hasContributing, false);
  assert.deepEqual(facts.runtimes, [{ name: 'go', constraint: '1.23', source: 'go.mod' }]);
});

test('a devcontainer directory is detected even when the root entry was missed', () => {
  const facts = assembleSetupFacts({
    treeNames: ['README.md'],
    treeTruncated: true,
    compose: null,
    runtimeSources: {},
    envFiles: [],
    workflowNames: [],
    workflowTexts: [],
    devcontainerNames: ['devcontainer.json'],
  });
  assert.equal(facts.hasDevcontainer, true);
  assert.equal(facts.treeTruncated, true);
});

// ---------------------------------------------------------------------------
// Regressions from running against a real corpus
// ---------------------------------------------------------------------------

test('unresolved build placeholders are not versions', () => {
  // A real corpus row read "java ${java.vers": the pom declared <java.version>${java.version}</...>,
  // deferring to another property. Reporting the literal placeholder is worse than reporting nothing.
  const selfReferential = parseRuntimes({
    pomXml: '<project><properties><java.version>${java.version}</java.version></properties></project>',
  });
  assert.deepEqual(selfReferential, [], 'no runtime rather than a fake one');

  // Falls through to the next property when the first is a placeholder.
  const withFallback = parseRuntimes({
    pomXml:
      '<project><properties><java.version>${java.version}</java.version>' +
      '<maven.compiler.release>17</maven.compiler.release></properties></project>',
  });
  assert.deepEqual(withFallback, [{ name: 'java', constraint: '17', source: 'pom.xml' }]);

  assert.deepEqual(parseRuntimes({ nvmrc: '{{ NODE_VERSION }}' }), []);
  assert.deepEqual(parseRuntimes({ goMod: 'module x\n\ngo @GO_VERSION@\n' }), []);
});

test('.tool-versions is filtered to language runtimes', () => {
  // A real corpus row read "bats 1.8.2, shel" — asdf manages linters and test harnesses too.
  const runtimes = parseRuntimes({
    toolVersions: 'bats 1.8.2\nshellcheck 0.9.0\njq 1.7\nnodejs 22.2.0\npython 3.12.1\n',
  });
  assert.deepEqual(
    runtimes.map((runtime) => runtime.name),
    ['nodejs', 'python'],
    'test tooling is not a runtime constraint',
  );
});
