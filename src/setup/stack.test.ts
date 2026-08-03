import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectStacks, resolveStackTerm, STACK_LABELS, LANGUAGE_ALIASES } from './stack.ts';

test('React is detected from a declared dependency, not from the name', () => {
  // The whole point: "show me React projects" must not mean "repos with React in the title".
  assert.deepEqual(
    detectStacks({ packageJson: JSON.stringify({ dependencies: { react: '^18.3.1' } }) }),
    ['react'],
  );
});

test('devDependencies and peerDependencies count', () => {
  assert.deepEqual(
    detectStacks({ packageJson: JSON.stringify({ devDependencies: { vite: '^6', jest: '^29' } }) }),
    ['jest', 'vite'],
  );
});

test('scoped families are matched by prefix', () => {
  assert.deepEqual(
    detectStacks({ packageJson: JSON.stringify({ dependencies: { '@angular/core': '^18' } }) }),
    ['angular'],
  );
  assert.deepEqual(
    detectStacks({ packageJson: JSON.stringify({ dependencies: { '@nestjs/common': '^10' } }) }),
    ['nestjs'],
  );
});

test('an unparseable manifest is a fact about the repo, not a crash', () => {
  assert.deepEqual(detectStacks({ packageJson: '{ this is not json' }), []);
});

test('Django is detected from either pyproject dialect', () => {
  const pep621 = detectStacks({
    pyproject: 'dependencies = [\n  "Django>=4.2",\n  "celery",\n]\n',
  });
  assert.deepEqual(pep621, ['celery', 'django']);

  const poetry = detectStacks({
    pyproject: '[tool.poetry.dependencies]\npython = "^3.11"\ndjango = "^5.0"\n\n[tool.other]\nx = 1\n',
  });
  assert.deepEqual(poetry, ['django']);
});

test('python is not reported as a framework of itself', () => {
  const stacks = detectStacks({ pyproject: '[tool.poetry.dependencies]\npython = "^3.11"\n' });
  assert.deepEqual(stacks, []);
});

test('requirements.txt is read, including pinned and extras forms', () => {
  const stacks = detectStacks({
    requirementsTxt: '# comment\nflask==3.0.0\nnumpy>=1.26\n-r other.txt\n\npandas[perf]\n',
  });
  assert.deepEqual(stacks, ['flask', 'numpy', 'pandas']);
});

test('go.mod require blocks and single-line requires both work', () => {
  const block = detectStacks({
    goMod: 'module x\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n\tk8s.io/client-go v0.29.0\n)\n',
  });
  assert.deepEqual(block, ['gin', 'kubernetes']);

  const single = detectStacks({ goMod: 'module x\n\nrequire github.com/spf13/cobra v1.8.0\n' });
  assert.deepEqual(single, ['cobra']);
});

test('Cargo dependencies are read from every dependency table', () => {
  const stacks = detectStacks({
    cargoToml: '[dependencies]\ntokio = { version = "1", features = ["full"] }\nserde = "1"\n\n[dev-dependencies]\naxum = "0.7"\n',
  });
  assert.deepEqual(stacks, ['axum', 'serde', 'tokio']);
});

test('Spring is detected from pom groupIds', () => {
  assert.deepEqual(
    detectStacks({ pomXml: '<project><dependencies><dependency><groupId>org.springframework.boot</groupId></dependency></dependencies></project>' }),
    ['spring'],
  );
});

test('topics fill the gap when no manifest could be read', () => {
  assert.deepEqual(detectStacks({}, ['react', 'frontend']), ['react']);
});

test('a topic cannot invent a stack outside the vocabulary', () => {
  // Otherwise the filter would offer thousands of options and stop being a filter.
  assert.deepEqual(detectStacks({}, ['my-cool-thing', 'webdev', 'hacktoberfest']), []);
});

test('topic spellings are normalised to the canonical name', () => {
  // GitHub carries next-js, nextjs and next.js for the same thing.
  for (const topic of ['nextjs', 'next-js', 'next.js', 'NextJS']) {
    assert.deepEqual(detectStacks({}, [topic]), ['nextjs'], topic);
  }
});

test('manifest and topic evidence combine without duplicating', () => {
  const stacks = detectStacks(
    { packageJson: JSON.stringify({ dependencies: { react: '^18' } }) },
    ['react', 'tailwindcss'],
  );
  assert.deepEqual(stacks, ['react', 'tailwind']);
});

test('detection is deterministic and sorted', () => {
  const once = detectStacks({ packageJson: JSON.stringify({ dependencies: { vue: '^3', express: '^4' } }) });
  assert.deepEqual(once, [...once].sort());
  assert.deepEqual(once, ['express', 'vue']);
});

// ---------------------------------------------------------------------------
// resolving a search term
// ---------------------------------------------------------------------------

test('"js" is a question about the language, and finds TypeScript too', () => {
  // The user's phrasing: "projects where JS is used". TypeScript projects are JavaScript projects for
  // this purpose, and a contributor who writes one can usually read the other.
  const resolved = resolveStackTerm('js');
  assert.deepEqual(resolved.languages, ['JavaScript', 'TypeScript']);
  assert.deepEqual(resolved.stacks, []);
});

test('"javascript" is as broad as "js", because a TypeScript project is JavaScript work', () => {
  // The narrow reading meant `stack=javascript` returned nothing on a TypeScript corpus while
  // `stack=js` returned everything, which is a distinction nobody asked for.
  assert.deepEqual(resolveStackTerm('javascript').languages, ['JavaScript', 'TypeScript']);
  assert.deepEqual(resolveStackTerm('js').languages, ['JavaScript', 'TypeScript']);
});

test('"ts" stays narrow, because the implication only runs one way', () => {
  assert.deepEqual(resolveStackTerm('ts').languages, ['TypeScript']);
  assert.deepEqual(resolveStackTerm('typescript').languages, ['TypeScript']);
});

test('an unrecognised term resolves to nothing, which callers must treat as "match nothing"', () => {
  // The SQL cannot infer "a stack was requested" from these arrays being empty — that is what made an
  // unknown term return the whole corpus. It passes a separate flag instead.
  const resolved = resolveStackTerm('quantum-blockchain');
  assert.deepEqual(resolved.stacks, []);
  assert.deepEqual(resolved.languages, []);
  assert.deepEqual(resolveStackTerm(''), { stacks: [], languages: [] });
});

test('"react" is a question about a library, not a language', () => {
  const resolved = resolveStackTerm('react');
  assert.deepEqual(resolved.stacks, ['react']);
  assert.deepEqual(resolved.languages, []);
});

test('"python" is both a language and an ecosystem, and resolves to both', () => {
  const resolved = resolveStackTerm('python');
  assert.deepEqual(resolved.languages, ['Python']);
});

test('term matching ignores casing and punctuation', () => {
  assert.deepEqual(resolveStackTerm('React Native').stacks, ['react-native']);
  assert.deepEqual(resolveStackTerm('nextjs').stacks, ['nextjs']);
  assert.deepEqual(resolveStackTerm('  TypeScript  ').languages, ['TypeScript']);
});

test('an unknown term resolves to nothing rather than everything', () => {
  const resolved = resolveStackTerm('quantum-blockchain');
  assert.deepEqual(resolved.stacks, []);
  assert.deepEqual(resolved.languages, []);
});

test('every rule has a label and every alias names a real language', () => {
  for (const [name, label] of Object.entries(STACK_LABELS)) {
    assert.ok(label.length > 0, `${name} has no label`);
    assert.equal(name, name.toLowerCase(), `${name} is not canonical`);
  }
  for (const [alias, languages] of Object.entries(LANGUAGE_ALIASES)) {
    assert.ok(languages.length > 0, `${alias} maps to nothing`);
  }
});
