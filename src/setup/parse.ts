import { parse as parseYaml } from 'yaml';

/**
 * Pure functions over file contents. No network, no database — every one of these can be checked by
 * eye against the repository it came from, which is the point of Slice 3 living here rather than
 * being inferred.
 */

// ---------------------------------------------------------------------------
// docker compose
// ---------------------------------------------------------------------------

/**
 * Keyword to backing service, matched as a substring of the NORMALISED image name.
 *
 * An earlier version anchored on a path separator, which missed vendor-prefixed images:
 * `confluentinc/cp-zookeeper:7.5.0` has "cp-" between the slash and the keyword. Normalising to the
 * final path segment without its tag makes prefixes, registries and digests all irrelevant.
 */
const SERVICE_KEYWORDS: [string[], string][] = [
  [['postgres', 'postgis', 'pgvector', 'timescale'], 'postgres'],
  [['mysql', 'mariadb', 'percona'], 'mysql'],
  [['mongo'], 'mongodb'],
  [['redis', 'valkey', 'keydb', 'dragonfly'], 'redis'],
  [['memcached'], 'memcached'],
  [['kafka', 'redpanda'], 'kafka'],
  [['zookeeper'], 'zookeeper'],
  [['rabbitmq'], 'rabbitmq'],
  [['nats'], 'nats'],
  [['elasticsearch', 'opensearch'], 'elasticsearch'],
  [['clickhouse'], 'clickhouse'],
  [['cassandra', 'scylla'], 'cassandra'],
  [['neo4j'], 'neo4j'],
  [['minio', 'localstack'], 'object-storage'],
  [['temporal'], 'temporal'],
  [['vault', 'keycloak', 'hydra'], 'auth'],
  [['prometheus', 'grafana', 'jaeger', 'otel', 'opentelemetry', 'tempo', 'loki'], 'observability'],
  [['mailhog', 'mailpit', 'maildev'], 'mail'],
  [['qdrant', 'weaviate', 'milvus', 'chroma'], 'vector-db'],
  [['nginx', 'traefik', 'caddy', 'envoy'], 'proxy'],
  [['selenium', 'playwright'], 'browser-grid'],
];

/** `public.ecr.aws/docker/library/redis:7.2@sha256:abc` -> `redis`. */
export function normalizeImageName(image: string): string {
  const withoutDigest = image.split('@')[0] ?? image;
  const segments = withoutDigest.split('/');
  const last = segments[segments.length - 1] ?? '';
  // A tag may contain dots but never a colon, so splitting on the first colon is safe.
  return (last.split(':')[0] ?? '').toLowerCase();
}

const DATABASES = new Set(['postgres', 'mysql', 'mongodb', 'cassandra', 'clickhouse', 'neo4j', 'vector-db']);
const CACHES = new Set(['redis', 'memcached']);
const QUEUES = new Set(['kafka', 'rabbitmq', 'nats', 'temporal']);

export interface ComposeFacts {
  path: string;
  services: number;
  serviceNames: string[];
  buildsLocal: boolean;
  images: string[];
  externalServices: string[];
}

/** Returns null when the file is absent, empty, or not parseable as a compose file. */
export function parseCompose(path: string, text: string | null | undefined): ComposeFacts | null {
  if (!text || text.trim().length === 0) return null;

  let document: unknown;
  try {
    document = parseYaml(text);
  } catch {
    // Malformed or templated YAML (Helm-style placeholders are common). Absence of facts is a
    // better outcome than invented ones.
    return null;
  }
  if (typeof document !== 'object' || document === null) return null;

  const services = (document as { services?: unknown }).services;
  if (typeof services !== 'object' || services === null) return null;

  const entries = Object.entries(services as Record<string, unknown>);
  const serviceNames: string[] = [];
  const images: string[] = [];
  let buildsLocal = false;

  for (const [name, definition] of entries) {
    serviceNames.push(name);
    if (typeof definition !== 'object' || definition === null) continue;
    const spec = definition as { image?: unknown; build?: unknown };
    if (spec.build !== undefined && spec.build !== null) buildsLocal = true;
    if (typeof spec.image === 'string') images.push(spec.image);
  }

  const externalServices = new Set<string>();
  for (const image of images) {
    const name = normalizeImageName(image);
    for (const [keywords, service] of SERVICE_KEYWORDS) {
      if (keywords.some((keyword) => name.includes(keyword))) externalServices.add(service);
    }
  }

  return {
    path,
    services: entries.length,
    serviceNames,
    buildsLocal,
    images,
    externalServices: [...externalServices].sort(),
  };
}

// ---------------------------------------------------------------------------
// runtimes
// ---------------------------------------------------------------------------

export interface Runtime {
  name: string;
  constraint: string;
  /** Which file the constraint came from, so a surprising value can be traced. */
  source: string;
}

/** Unresolved build-tool placeholders: Maven ${prop}, Gradle/Ant @token@, mustache {{x}}. */
const PLACEHOLDER = /\$\{|\{\{|@[\w.-]+@/;

function clean(value: string): string {
  const trimmed = value.trim();
  // A placeholder means the real version lives elsewhere in the build config. Reporting the literal
  // "${java.version}" as a runtime constraint is worse than reporting nothing.
  if (PLACEHOLDER.test(trimmed)) return '';
  return trimmed.replace(/^v/, '').slice(0, 40);
}

/**
 * .tool-versions lists whatever asdf/mise manages, which includes linters and test harnesses
 * (bats, shellcheck, jq). Only language runtimes belong in a runtime column.
 */
const RUNTIME_NAMES = new Set([
  'node', 'nodejs', 'python', 'go', 'golang', 'java', 'ruby', 'rust', 'dotnet', 'dotnet-core',
  'php', 'erlang', 'elixir', 'deno', 'bun', 'kotlin', 'scala', 'swift', 'dart', 'perl', 'r',
  'clojure', 'crystal', 'zig', 'julia', 'haskell',
]);

export interface RuntimeSources {
  packageJson?: string | null;
  nvmrc?: string | null;
  toolVersions?: string | null;
  pyproject?: string | null;
  goMod?: string | null;
  cargoToml?: string | null;
  pomXml?: string | null;
}

/**
 * Version constraints only. Deliberately regex-based for the TOML and XML sources: one field from
 * each is wanted, and a full parser for each ecosystem is a dependency and a failure mode for no
 * additional signal.
 */
export function parseRuntimes(sources: RuntimeSources): Runtime[] {
  const runtimes: Runtime[] = [];
  const seen = new Set<string>();
  const add = (name: string, constraint: string, source: string): boolean => {
    const value = clean(constraint);
    if (!value || seen.has(name)) return false;
    seen.add(name);
    runtimes.push({ name, constraint: value, source });
    return true;
  };

  if (sources.packageJson) {
    try {
      const pkg = JSON.parse(sources.packageJson) as {
        engines?: Record<string, string>;
      };
      if (pkg.engines?.['node']) add('node', pkg.engines['node'], 'package.json');
      if (pkg.engines?.['python']) add('python', pkg.engines['python'], 'package.json');
    } catch {
      // Malformed package.json; the tree still told us it exists.
    }
  }
  if (sources.nvmrc) add('node', sources.nvmrc.split('\n')[0] ?? '', '.nvmrc');

  if (sources.toolVersions) {
    for (const line of sources.toolVersions.split('\n')) {
      const match = /^\s*([a-z0-9_-]+)\s+([^\s#]+)/i.exec(line);
      if (!match) continue;
      const tool = match[1]!.toLowerCase();
      if (RUNTIME_NAMES.has(tool)) add(tool, match[2]!, '.tool-versions');
    }
  }

  if (sources.pyproject) {
    const requires = /requires-python\s*=\s*["']([^"']+)["']/.exec(sources.pyproject);
    if (requires) add('python', requires[1]!, 'pyproject.toml');
  }
  if (sources.goMod) {
    const version = /^\s*go\s+(\d+(?:\.\d+)*)/m.exec(sources.goMod);
    if (version) add('go', version[1]!, 'go.mod');
  }
  if (sources.cargoToml) {
    const version = /rust-version\s*=\s*["']([^"']+)["']/.exec(sources.cargoToml);
    if (version) add('rust', version[1]!, 'Cargo.toml');
  }
  if (sources.pomXml) {
    const patterns = [
      /<maven\.compiler\.release>([^<]+)</,
      /<maven\.compiler\.source>([^<]+)</,
      /<java\.version>([^<]+)</,
      /<release>([^<]+)</,
    ];
    // Try each in turn: the first property is often itself a placeholder pointing at another.
    for (const pattern of patterns) {
      const match = pattern.exec(sources.pomXml);
      if (match && add('java', match[1]!, 'pom.xml')) break;
    }
  }

  return runtimes;
}

// ---------------------------------------------------------------------------
// environment variables
// ---------------------------------------------------------------------------

/**
 * Counts declared variables in a dotenv template. Comments, blanks and `export` prefixes are
 * handled; a commented-out variable is not a variable you must supply.
 */
export function countEnvVars(text: string | null | undefined): number | null {
  if (text === null || text === undefined) return null;
  let count = 0;
  for (const line of text.split('\n')) {
    if (/^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)) count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// tree-derived presence
// ---------------------------------------------------------------------------

const LOCKFILE_MANAGERS: [string, string][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
  ['uv.lock', 'uv'],
  ['poetry.lock', 'poetry'],
  ['Pipfile.lock', 'pipenv'],
];

const MONOREPO_MARKERS = ['pnpm-workspace.yaml', 'lerna.json', 'turbo.json', 'nx.json', 'rush.json'];

export interface TreeFacts {
  hasDockerfile: boolean;
  hasDevcontainer: boolean;
  hasContributing: boolean;
  hasReadme: boolean;
  taskRunner: string;
  packageManager: string | null;
  isMonorepoByMarker: boolean;
}

/** `names` is the set of root-level entry names, matched case-insensitively. */
export function parseTree(names: string[]): TreeFacts {
  const lower = new Set(names.map((name) => name.toLowerCase()));
  const has = (name: string): boolean => lower.has(name.toLowerCase());
  const hasPrefix = (prefix: string): boolean =>
    [...lower].some((name) => name.startsWith(prefix.toLowerCase()));

  const taskRunner = has('Makefile') || has('makefile') || has('GNUmakefile')
    ? 'make'
    : has('Taskfile.yml') || has('Taskfile.yaml')
      ? 'task'
      : has('justfile') || has('Justfile') || has('.justfile')
        ? 'just'
        : 'none';

  let packageManager: string | null = null;
  for (const [lockfile, manager] of LOCKFILE_MANAGERS) {
    if (has(lockfile)) {
      packageManager = manager;
      break;
    }
  }

  return {
    // Dockerfile.dev, Dockerfile.prod and so on all count.
    hasDockerfile: hasPrefix('dockerfile'),
    hasDevcontainer: has('.devcontainer') || has('.devcontainer.json'),
    hasContributing: hasPrefix('contributing'),
    hasReadme: hasPrefix('readme'),
    taskRunner,
    packageManager,
    isMonorepoByMarker: MONOREPO_MARKERS.some((marker) => has(marker)),
  };
}

/** packageManager field in package.json wins over lockfile inference when both are present. */
export function declaredPackageManager(packageJson: string | null | undefined): string | null {
  if (!packageJson) return null;
  try {
    const pkg = JSON.parse(packageJson) as { packageManager?: unknown };
    if (typeof pkg.packageManager === 'string') {
      return pkg.packageManager.split('@')[0] ?? null;
    }
  } catch {
    return null;
  }
  return null;
}

export function hasWorkspaces(packageJson: string | null | undefined): boolean {
  if (!packageJson) return false;
  try {
    const pkg = JSON.parse(packageJson) as { workspaces?: unknown };
    return Array.isArray(pkg.workspaces) || typeof pkg.workspaces === 'object';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// CI
// ---------------------------------------------------------------------------

/**
 * Whether any of the workflow files we could read triggers on pull requests.
 *
 * Returns null when none were readable: a project whose CI lives in an unconventionally named file
 * should read as undetermined, not as having no CI.
 */
export function ciRunsOnPullRequest(workflowTexts: (string | null | undefined)[]): boolean | null {
  const readable = workflowTexts.filter((text): text is string => Boolean(text));
  if (readable.length === 0) return null;

  let determined = 0;

  for (const text of readable) {
    let document: unknown;
    try {
      document = parseYaml(text);
    } catch {
      continue;
    }
    if (typeof document !== 'object' || document === null) continue;
    // `on` is the YAML 1.1 boolean true, which a parser may key either way.
    const record = document as Record<string, unknown>;
    const triggers = record['on'] ?? record['true'];
    if (triggers === undefined || triggers === null) continue;

    determined += 1;

    if (typeof triggers === 'string') {
      if (triggers.startsWith('pull_request')) return true;
    } else if (Array.isArray(triggers)) {
      if (triggers.some((trigger) => String(trigger).startsWith('pull_request'))) return true;
    } else if (typeof triggers === 'object') {
      if (Object.keys(triggers as Record<string, unknown>).some((key) => key.startsWith('pull_request'))) {
        return true;
      }
    }
  }

  // Text arrived but nothing declared triggers we could read: undetermined, not "no CI on PRs".
  return determined > 0 ? false : null;
}

// ---------------------------------------------------------------------------
// verdict
// ---------------------------------------------------------------------------

export interface SetupFacts {
  treeTruncated: boolean;
  filesSeen: number;

  composePath: string | null;
  composeServices: number | null;
  composeServiceNames: string[];
  composeBuildsLocal: boolean | null;
  hasDockerfile: boolean;
  hasDevcontainer: boolean;

  runtimes: Runtime[];
  packageManager: string | null;
  isMonorepo: boolean;

  envExamplePath: string | null;
  envVarCount: number | null;

  hasContributing: boolean;
  hasReadme: boolean;
  taskRunner: string;

  ciWorkflowCount: number;
  ciRunsOnPr: boolean | null;

  externalServices: string[];
  needsDatabase: boolean;
  needsCache: boolean;
  needsQueue: boolean;

  setupWeight: 'unknown' | 'light' | 'moderate' | 'heavy';
}

/**
 * Ordinal, from burden alone. A devcontainer or task runner is reported alongside rather than folded
 * in, because "heavy but one command to start" and "heavy with no documented path in" are different
 * situations and averaging them into a single score loses exactly the distinction that matters.
 *
 * These thresholds are opening guesses, like the Slice 2 ones. The difference is that every input is
 * checkable against the repository in a few seconds.
 */
export function classifySetupWeight(
  facts: Pick<
    SetupFacts,
    | 'treeTruncated'
    | 'filesSeen'
    | 'composeServices'
    | 'envVarCount'
    | 'needsDatabase'
    | 'needsQueue'
    | 'externalServices'
    | 'isMonorepo'
  >,
): SetupFacts['setupWeight'] {
  // No tree means no evidence, which is not the same as a simple project.
  //
  // A *truncated* tree is the same problem and used to be unreachable: treeTruncated was defined as
  // `filesSeen === 0`, so the two conditions coincided and this parameter was never actually read.
  // Now that the reading walks the whole tree, GitHub can stop listing partway through a very large
  // repository — and concluding `light` from a partial listing is precisely the wrong answer that the
  // move away from root-only reading exists to eliminate. Under-reporting is the only direction this
  // can fail in, so it must not report at all.
  if (facts.treeTruncated || facts.filesSeen === 0) return 'unknown';

  const services = facts.composeServices ?? 0;
  const envVars = facts.envVarCount ?? 0;

  if (
    services >= 5 ||
    envVars >= 12 ||
    (facts.needsQueue && facts.needsDatabase) ||
    facts.externalServices.length >= 4
  ) {
    return 'heavy';
  }
  if (services >= 2 || envVars >= 4 || facts.needsDatabase || facts.needsQueue || facts.isMonorepo) {
    return 'moderate';
  }
  return 'light';
}

export interface AssembleInput {
  treeNames: string[];
  treeTruncated: boolean;
  compose: ComposeFacts | null;
  runtimeSources: RuntimeSources;
  envFiles: { path: string; text: string | null | undefined }[];
  workflowNames: string[];
  workflowTexts: (string | null | undefined)[];
  devcontainerNames: string[];
}

export function assembleSetupFacts(input: AssembleInput): SetupFacts {
  const tree = parseTree(input.treeNames);
  const runtimes = parseRuntimes(input.runtimeSources);

  const envFile = input.envFiles.find((file) => file.text !== null && file.text !== undefined);
  const envVarCount = countEnvVars(envFile?.text);

  const external = input.compose?.externalServices ?? [];
  const needsDatabase = external.some((service) => DATABASES.has(service));
  const needsCache = external.some((service) => CACHES.has(service));
  const needsQueue = external.some((service) => QUEUES.has(service));

  const isMonorepo = tree.isMonorepoByMarker || hasWorkspaces(input.runtimeSources.packageJson);

  const base = {
    treeTruncated: input.treeTruncated,
    filesSeen: input.treeNames.length,

    composePath: input.compose?.path ?? null,
    composeServices: input.compose?.services ?? null,
    composeServiceNames: input.compose?.serviceNames ?? [],
    composeBuildsLocal: input.compose?.buildsLocal ?? null,
    hasDockerfile: tree.hasDockerfile,
    hasDevcontainer: tree.hasDevcontainer || input.devcontainerNames.length > 0,

    runtimes,
    packageManager:
      declaredPackageManager(input.runtimeSources.packageJson) ?? tree.packageManager,
    isMonorepo,

    envExamplePath: envFile?.path ?? null,
    envVarCount,

    hasContributing: tree.hasContributing,
    hasReadme: tree.hasReadme,
    taskRunner: tree.taskRunner,

    ciWorkflowCount: input.workflowNames.filter((name) => /\.ya?ml$/i.test(name)).length,
    ciRunsOnPr: ciRunsOnPullRequest(input.workflowTexts),

    externalServices: external,
    needsDatabase,
    needsCache,
    needsQueue,
  };

  return { ...base, setupWeight: classifySetupWeight(base) };
}
