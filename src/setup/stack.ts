/**
 * What a project is actually built with. PURE: text in, names out.
 *
 * The point is to answer "show me React projects" from evidence rather than from the repository name.
 * Three sources, in descending order of trustworthiness:
 *
 * 1. **Declared dependencies.** `react` in `package.json` is not an opinion. This is the good signal.
 * 2. **GitHub topics.** Maintainer-applied, so usually right but often absent, and sometimes
 *    aspirational.
 * 3. **Primary language.** Only tells you the language, which is why `js` and `react` need to be
 *    different questions.
 *
 * Every manifest read here — package.json, pyproject.toml, go.mod, Cargo.toml, pom.xml — is already
 * fetched for runtime detection, so framework detection costs no additional API requests.
 *
 * Deliberately a fixed vocabulary rather than "every dependency". A project with 400 transitive
 * dependencies is not usefully described by all of them, and a filter offering 40,000 options is not
 * a filter. The list below is the set of things somebody might reasonably say "I want to work on".
 */

/**
 * Detection rules. `deps` are matched against declared dependency names, `exact` requires the whole
 * name, `prefix` matches scoped families like `@angular/core`.
 */
interface StackRule {
  /** Canonical name, lowercase. What the filter and the UI use. */
  name: string;
  /** Human label for the picker. */
  label: string;
  /** Ecosystem this rule reads from. */
  from: 'npm' | 'python' | 'go' | 'rust' | 'java';
  exact?: string[];
  prefix?: string[];
  /**
   * Alternative spellings used as GitHub topics.
   *
   * Declared rather than derived: the topic is often not the package name — Tailwind's package is
   * `tailwindcss` while the sensible filter label is `tailwind`, and collapsing punctuation does not
   * bridge that. Guessing also risks false matches in the other direction: `angularjs` is Angular 1,
   * a different framework, and must NOT alias to `angular`.
   */
  topics?: string[];
}

const RULES: StackRule[] = [
  // --- JavaScript and TypeScript ------------------------------------------
  { name: 'react', label: 'React', from: 'npm', exact: ['react'], prefix: ['@types/react'] },
  { name: 'nextjs', label: 'Next.js', from: 'npm', exact: ['next'], topics: ['next', 'nextjs'] },
  { name: 'vue', label: 'Vue', from: 'npm', exact: ['vue'], prefix: ['@vue/'], topics: ['vuejs', 'vue3'] },
  // Note: NOT aliased from `angularjs`, which is Angular 1 and a different framework.
  { name: 'angular', label: 'Angular', from: 'npm', prefix: ['@angular/'] },
  { name: 'svelte', label: 'Svelte', from: 'npm', exact: ['svelte'], topics: ['sveltekit'] },
  { name: 'express', label: 'Express', from: 'npm', exact: ['express'] },
  { name: 'nestjs', label: 'NestJS', from: 'npm', prefix: ['@nestjs/'] },
  { name: 'electron', label: 'Electron', from: 'npm', exact: ['electron'] },
  { name: 'react-native', label: 'React Native', from: 'npm', exact: ['react-native'], topics: ['reactnative'] },
  { name: 'tailwind', label: 'Tailwind CSS', from: 'npm', exact: ['tailwindcss'], topics: ['tailwindcss', 'tailwind-css'] },
  { name: 'vite', label: 'Vite', from: 'npm', exact: ['vite'] },
  { name: 'webpack', label: 'webpack', from: 'npm', exact: ['webpack'] },
  { name: 'jest', label: 'Jest', from: 'npm', exact: ['jest'] },
  { name: 'playwright', label: 'Playwright', from: 'npm', exact: ['playwright', '@playwright/test'] },

  // --- Python -------------------------------------------------------------
  { name: 'django', label: 'Django', from: 'python', exact: ['django'] },
  { name: 'flask', label: 'Flask', from: 'python', exact: ['flask'] },
  { name: 'fastapi', label: 'FastAPI', from: 'python', exact: ['fastapi'] },
  { name: 'pytorch', label: 'PyTorch', from: 'python', exact: ['torch', 'pytorch'], topics: ['torch'] },
  { name: 'tensorflow', label: 'TensorFlow', from: 'python', exact: ['tensorflow'] },
  { name: 'pandas', label: 'pandas', from: 'python', exact: ['pandas'] },
  { name: 'numpy', label: 'NumPy', from: 'python', exact: ['numpy'] },
  { name: 'pytest', label: 'pytest', from: 'python', exact: ['pytest'] },
  { name: 'celery', label: 'Celery', from: 'python', exact: ['celery'] },
  { name: 'sqlalchemy', label: 'SQLAlchemy', from: 'python', exact: ['sqlalchemy'] },

  // --- Go -----------------------------------------------------------------
  { name: 'gin', label: 'Gin', from: 'go', prefix: ['github.com/gin-gonic/gin'] },
  { name: 'echo', label: 'Echo', from: 'go', prefix: ['github.com/labstack/echo'] },
  { name: 'cobra', label: 'Cobra', from: 'go', prefix: ['github.com/spf13/cobra'] },
  { name: 'kubernetes', label: 'Kubernetes', from: 'go', prefix: ['k8s.io/'], topics: ['k8s'] },

  // --- Rust ---------------------------------------------------------------
  { name: 'tokio', label: 'Tokio', from: 'rust', exact: ['tokio'] },
  { name: 'axum', label: 'Axum', from: 'rust', exact: ['axum'] },
  { name: 'actix', label: 'Actix', from: 'rust', exact: ['actix-web', 'actix'] },
  { name: 'serde', label: 'Serde', from: 'rust', exact: ['serde'] },
  { name: 'tauri', label: 'Tauri', from: 'rust', exact: ['tauri'] },

  // --- Java ---------------------------------------------------------------
  { name: 'spring', label: 'Spring', from: 'java', prefix: ['org.springframework'], topics: ['spring-boot', 'springboot'] },
];

/** For the picker, and so the UI never invents a label. */
export const STACK_LABELS: Record<string, string> = Object.fromEntries(
  RULES.map((rule) => [rule.name, rule.label]),
);

/**
 * Language aliases, so "js" finds JavaScript and TypeScript projects.
 *
 * A separate mechanism from the rules above on purpose: "JS" is a question about the language, "React"
 * is a question about a library, and conflating them is what makes a search feel like it is guessing.
 * Values are matched against `repos.primary_language`, case-insensitively.
 */
export const LANGUAGE_ALIASES: Record<string, string[]> = {
  // Both spellings include TypeScript. Someone asking for JavaScript work will almost always take a
  // TypeScript project, and the reverse is not true — so `ts` stays narrow while `js` and `javascript`
  // are broad. When you genuinely want only plain JavaScript, the `language` filter is exact.
  js: ['JavaScript', 'TypeScript'],
  javascript: ['JavaScript', 'TypeScript'],
  ts: ['TypeScript'],
  typescript: ['TypeScript'],
  py: ['Python'],
  python: ['Python'],
  go: ['Go'],
  golang: ['Go'],
  rust: ['Rust'],
  java: ['Java'],
  ruby: ['Ruby'],
  php: ['PHP'],
  csharp: ['C#'],
  cpp: ['C++'],
};

export interface ManifestSources {
  packageJson?: string | null;
  pyproject?: string | null;
  requirementsTxt?: string | null;
  goMod?: string | null;
  cargoToml?: string | null;
  pomXml?: string | null;
}

/**
 * Declared dependency names per ecosystem.
 *
 * Direct dependencies only. Transitive ones would report React for anything that happens to depend on
 * a component library, which is not what "I want to work on React" means.
 */
export function declaredDependencies(sources: ManifestSources): Map<StackRule['from'], Set<string>> {
  const out = new Map<StackRule['from'], Set<string>>();
  const put = (from: StackRule['from'], names: Iterable<string>): void => {
    const set = out.get(from) ?? new Set<string>();
    for (const name of names) set.add(name.toLowerCase());
    out.set(from, set);
  };

  put('npm', npmDependencies(sources.packageJson));
  put('python', [...pyprojectDependencies(sources.pyproject), ...requirementNames(sources.requirementsTxt)]);
  put('go', goModDependencies(sources.goMod));
  put('rust', cargoDependencies(sources.cargoToml));
  put('java', pomDependencies(sources.pomXml));
  return out;
}

function npmDependencies(text: string | null | undefined): string[] {
  if (!text) return [];
  try {
    const pkg = JSON.parse(text) as Record<string, unknown>;
    const names: string[] = [];
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      const block = pkg[field];
      if (block && typeof block === 'object' && !Array.isArray(block)) {
        names.push(...Object.keys(block as Record<string, unknown>));
      }
    }
    return names;
  } catch {
    // A package.json that does not parse is a fact about the repo, not a reason to fail the run.
    return [];
  }
}

/**
 * `pyproject.toml` without a TOML parser.
 *
 * Handles the two shapes that matter: PEP 621 `dependencies = ["django>=4"]` and Poetry's
 * `[tool.poetry.dependencies]` table. A real parser would be more correct; this is a name extractor
 * feeding a fixed vocabulary, and a missed exotic syntax costs one absent tag rather than a wrong one.
 */
function pyprojectDependencies(text: string | null | undefined): string[] {
  if (!text) return [];
  const names: string[] = [];

  // PEP 621 / Poetry array form, possibly spanning lines.
  for (const match of text.matchAll(/dependencies\s*=\s*\[([\s\S]*?)\]/g)) {
    for (const entry of match[1]!.matchAll(/["']\s*([A-Za-z0-9._-]+)/g)) {
      names.push(entry[1]!);
    }
  }
  // Poetry table form: names are keys until the next section header.
  const poetry = /\[tool\.poetry\.(?:dev-)?dependencies\]([\s\S]*?)(?=\n\[|$)/g;
  for (const match of text.matchAll(poetry)) {
    for (const line of match[1]!.split('\n')) {
      const key = /^\s*([A-Za-z0-9._-]+)\s*=/.exec(line);
      if (key && key[1]!.toLowerCase() !== 'python') names.push(key[1]!);
    }
  }
  return names;
}

function requirementNames(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('-'))
    .map((line) => /^([A-Za-z0-9._-]+)/.exec(line)?.[1] ?? '')
    .filter(Boolean);
}

/** Module paths from `require` blocks and single-line requires in go.mod. */
function goModDependencies(text: string | null | undefined): string[] {
  if (!text) return [];
  const names: string[] = [];
  for (const match of text.matchAll(/require\s*\(([\s\S]*?)\)/g)) {
    for (const line of match[1]!.split('\n')) {
      const path = /^\s*([^\s]+)\s+v/.exec(line);
      if (path) names.push(path[1]!);
    }
  }
  for (const match of text.matchAll(/^require\s+([^\s]+)\s+v/gm)) names.push(match[1]!);
  return names;
}

/** Crate names from the `[dependencies]` and `[dev-dependencies]` tables in Cargo.toml. */
function cargoDependencies(text: string | null | undefined): string[] {
  if (!text) return [];
  const names: string[] = [];
  const section = /\[(?:dev-|build-)?dependencies\]([\s\S]*?)(?=\n\[|$)/g;
  for (const match of text.matchAll(section)) {
    for (const line of match[1]!.split('\n')) {
      const key = /^\s*([A-Za-z0-9._-]+)\s*=/.exec(line);
      if (key) names.push(key[1]!);
    }
  }
  return names;
}

/** groupId values from pom.xml. Enough to tell Spring from not-Spring. */
function pomDependencies(text: string | null | undefined): string[] {
  if (!text) return [];
  return [...text.matchAll(/<groupId>([^<]+)<\/groupId>/g)].map((match) => match[1]!.trim());
}

/**
 * The frameworks a project declares, as canonical lowercase names.
 *
 * Topics are folded in so a maintainer-applied `react` tag still counts when the manifest is absent or
 * unparseable — but only for names already in the vocabulary, so a topic cannot invent a stack.
 */
export function detectStacks(sources: ManifestSources, topics: string[] = []): string[] {
  const declared = declaredDependencies(sources);
  const found = new Set<string>();

  for (const rule of RULES) {
    const names = declared.get(rule.from);
    if (!names) continue;
    const hit =
      (rule.exact ?? []).some((name) => names.has(name.toLowerCase())) ||
      (rule.prefix ?? []).some((prefix) =>
        [...names].some((name) => name.startsWith(prefix.toLowerCase())),
      );
    if (hit) found.add(rule.name);
  }

  for (const topic of topics) {
    const name = canonicalStack(topic);
    if (name) found.add(name);
  }

  return [...found].sort();
}

/**
 * Resolves a search term to the things it should match.
 *
 * One term, two possible meanings, and the caller needs both: `react` is a framework, `js` is a pair
 * of languages, and `python` is both a language and the ecosystem several frameworks come from.
 */
/**
 * A topic or search term to a canonical stack name, or null if it is not in the vocabulary.
 *
 * Punctuation is collapsed so `next-js`, `nextjs` and `next.js` agree, but only against the declared
 * name and topic aliases — never against an arbitrary substring, which is how a search starts matching
 * things it should not.
 */
export function canonicalStack(term: string): string | null {
  const normalised = term.trim().toLowerCase();
  const collapsed = normalised.replace(/[-_.\s]/g, '');
  for (const rule of RULES) {
    const spellings = [rule.name, ...(rule.topics ?? [])];
    if (spellings.some((s) => s === normalised || s.replace(/[-_.]/g, '') === collapsed)) {
      return rule.name;
    }
  }
  return null;
}

export function resolveStackTerm(term: string): { stacks: string[]; languages: string[] } {
  const normalised = term.trim().toLowerCase();
  const collapsed = normalised.replace(/[-_.\s]/g, '');

  const canonical = canonicalStack(normalised);
  const stacks = canonical ? [canonical] : [];
  const languages = LANGUAGE_ALIASES[normalised] ?? LANGUAGE_ALIASES[collapsed] ?? [];

  return { stacks, languages };
}
