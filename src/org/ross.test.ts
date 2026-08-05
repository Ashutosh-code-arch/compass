import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRossCsv, RossError, splitCsvLine } from './ross.ts';

test('quoted fields containing commas survive', () => {
  // The only CSV complication these machine-generated datasets actually present.
  assert.deepEqual(splitCsvLine('a,"Palo Alto, CA",c'), ['a', 'Palo Alto, CA', 'c']);
  assert.deepEqual(splitCsvLine('a,"say ""hi""",c'), ['a', 'say "hi"', 'c']);
});

/**
 * Columns are found by name, not position. A positional parser would read growth multiples as star
 * counts the first time somebody inserted a column, and nothing in the output would look wrong.
 */
test('columns are matched by name in any order', () => {
  const parsed = parseRossCsv(
    ['Funding,Repository,Founded,Organization', 'YC W22,acme/widgets,2021,Acme Inc'].join('\n'),
  );
  assert.equal(parsed.rows.length, 1);
  assert.deepEqual(parsed.rows[0], {
    login: 'acme',
    repoFullName: 'acme/widgets',
    funding: 'YC W22',
    foundedYear: 2021,
  });
  // Reported so a surprising import can be explained rather than re-guessed.
  assert.equal(parsed.columns['funding'], 'Funding');
});

test('a GitHub URL reduces to its owner', () => {
  const parsed = parseRossCsv(
    ['repo', 'https://github.com/hog/monopoly', 'github.com/ghost/townn.git'].join('\n'),
  );
  assert.deepEqual(parsed.rows.map((row) => row.login), ['hog', 'ghost']);
});

test('the organisation column is a fallback when there is no repository', () => {
  const parsed = parseRossCsv(['Organization,Funding', 'cern-hsf,none'].join('\n'));
  assert.equal(parsed.rows[0]?.login, 'cern-hsf');
  assert.equal(parsed.rows[0]?.repoFullName, null);
});

test('an implausible founding year becomes null rather than a number', () => {
  const parsed = parseRossCsv(['repo,founded', 'acme/widgets,n/a', 'hog/monopoly,3200'].join('\n'));
  assert.equal(parsed.rows[0]?.foundedYear, null);
  assert.equal(parsed.rows[1]?.foundedYear, null);
});

test('duplicate organisations collapse', () => {
  const parsed = parseRossCsv(
    ['repo', 'acme/widgets', 'acme/gizmos', 'ACME/other'].join('\n'),
  );
  assert.equal(parsed.rows.length, 1);
});

// ------------------------------------------------------------------ refusals

/**
 * The same rule as the GSoC importer, in a new place: an empty or unrecognisable source is a failure,
 * never a finding that nothing is growing.
 */
test('an empty dataset is refused', () => {
  assert.throws(() => parseRossCsv('repo,stars\n'), RossError);
  assert.throws(() => parseRossCsv(''), RossError);
});

test('a dataset with no recognisable owner column is refused, and says what it saw', () => {
  assert.throws(
    () => parseRossCsv(['Rank,Stars,Growth', '1,50000,4.2'].join('\n')),
    /Could not find a repository or organisation column.*Rank, Stars, Growth/s,
  );
});

test('a dataset that is mostly unusable is refused rather than partly imported', () => {
  const csv = ['repo', '', '  ', '???', '!!!', '###', 'acme/widgets'].join('\n');
  assert.throws(() => parseRossCsv(csv), /this far from the expected shape/);
});

test('a few bad rows among good ones are skipped and counted', () => {
  const parsed = parseRossCsv(
    ['repo', 'acme/widgets', 'hog/monopoly', 'ghost/townn', '???'].join('\n'),
  );
  assert.equal(parsed.rows.length, 3);
  assert.equal(parsed.rejected.length, 1);
  assert.equal(parsed.rejected[0]?.line, 5);
});
