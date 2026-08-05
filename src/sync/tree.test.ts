import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findContributing, type RepoTree } from './tree.ts';

function tree(paths: string[], truncated = false): RepoTree {
  return { entries: paths.map((path) => ({ path, type: 'blob' })), truncated };
}

test('the root CONTRIBUTING wins over every other copy', () => {
  const found = findContributing(
    tree(['docs/CONTRIBUTING.md', '.github/CONTRIBUTING.md', 'CONTRIBUTING.md']),
  );
  assert.equal(found?.path, 'CONTRIBUTING.md');
});

test('.github outranks anywhere else', () => {
  const found = findContributing(tree(['docs/contributing/index.md', '.github/CONTRIBUTING.md']));
  assert.equal(found?.path, '.github/CONTRIBUTING.md');
});

/**
 * `docs/` is in IGNORED_SEGMENTS, correctly, for compose files: a documentation directory's compose
 * file is not how you run the project. It is not the wrong place to state a CLA requirement, though,
 * so this search allows it where `findCompose` must not.
 */
test('a docs copy is accepted when there is no better one', () => {
  const found = findContributing(tree(['README.md', 'docs/CONTRIBUTING.md']));
  assert.equal(found?.path, 'docs/CONTRIBUTING.md');
});

test('any extension, or none, is recognised', () => {
  assert.equal(findContributing(tree(['CONTRIBUTING.rst']))?.path, 'CONTRIBUTING.rst');
  assert.equal(findContributing(tree(['contributing.txt']))?.path, 'contributing.txt');
  assert.equal(findContributing(tree(['CONTRIBUTING']))?.path, 'CONTRIBUTING');
});

test('a vendored copy describes somebody else\u2019s project', () => {
  assert.equal(findContributing(tree(['node_modules/left-pad/CONTRIBUTING.md'])), null);
  assert.equal(findContributing(tree(['vendor/github.com/x/y/CONTRIBUTING.md'])), null);
});

test('a shallower copy wins within the same tier', () => {
  const found = findContributing(tree(['docs/i18n/fr/CONTRIBUTING.md', 'docs/CONTRIBUTING.md']));
  assert.equal(found?.path, 'docs/CONTRIBUTING.md');
});

test('absence is null, not a guess', () => {
  assert.equal(findContributing(tree(['README.md', 'src/index.ts'])), null);
});
