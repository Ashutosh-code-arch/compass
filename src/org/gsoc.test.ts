import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertUsableOrgList, OrgListError, parseOrgList } from './gsoc.ts';
import { gsocOutlook, GSOC_2026 } from './view.ts';

// ------------------------------------------------------------------- parsing

test('one login per line, with comments and blanks ignored', () => {
  const parsed = parseOrgList(`
# GSoC 2026, mapped by hand
python

  postgres   # inline comments end the login
`);
  assert.deepEqual(parsed.logins, ['python', 'postgres']);
  assert.deepEqual(parsed.rejected, []);
});

test('a full name reduces to its owner', () => {
  // Lists copied out of a repository index carry full names, and rejecting those would make a good
  // source look empty.
  assert.deepEqual(parseOrgList('postgres/postgres\ncern-hsf').logins, ['postgres', 'cern-hsf']);
});

test('duplicates collapse case-insensitively, keeping the first spelling', () => {
  assert.deepEqual(parseOrgList('CERN-HSF\ncern-hsf\nCern-Hsf').logins, ['CERN-HSF']);
});

test('things that are not logins are reported rather than skipped silently', () => {
  const parsed = parseOrgList('good-org\nPython Software Foundation\n-leading-hyphen\ntrailing-\na/b/c');
  assert.deepEqual(parsed.logins, ['good-org']);
  assert.deepEqual(
    parsed.rejected.map((entry) => entry.line),
    [2, 3, 4, 5],
  );
});

test('a login may contain digits and single hyphens', () => {
  assert.deepEqual(parseOrgList('web3-foundation\nnumpy\nx1').logins, [
    'web3-foundation',
    'numpy',
    'x1',
  ]);
});

// ------------------------------------------------------------------ refusals

/**
 * The failure this module exists for. A changed page, a failed download, or a wrong path all produce
 * an empty file, and an importer that accepts one records "no organisation participates in GSoC" — a
 * false finding, which is worse than a gap. This is the project's `null` ≠ `0` rule in a new place.
 */
test('an empty list is refused, not imported as an absence', () => {
  const parsed = parseOrgList('# comments only\n\n');
  assert.throws(() => assertUsableOrgList(parsed, 'gsoc-2026.txt'), OrgListError);
  assert.throws(() => assertUsableOrgList(parsed, 'gsoc-2026.txt'), /empty source is a failure/);
});

test('a file mostly of non-logins is refused rather than partly imported', () => {
  const parsed = parseOrgList(
    '<li>Python Software Foundation</li>\n<li>CERN-HSF</li>\n<li>Apache</li>\nacme\n',
  );
  // One line parsed. Importing that one would produce a plausible, dated, wrong claim.
  assert.equal(parsed.logins.length, 1);
  assert.throws(() => assertUsableOrgList(parsed, 'dump.html'), /did not parse/);
});

test('a healthy list with a few bad lines is accepted', () => {
  const parsed = parseOrgList('a\nb\nc\nd\nNot A Login\n');
  assert.doesNotThrow(() => assertUsableOrgList(parsed, 'list.txt'));
});

// ------------------------------------------------------------------ calendar

const outlookAt = (iso: string) => gsocOutlook(new Date(iso));

test('before the announcement, the message says the window is now', () => {
  const outlook = outlookAt('2026-01-10T00:00:00Z');
  assert.equal(outlook.phase, 'before-announcement');
  assert.equal(outlook.year, 2026);
  assert.equal(outlook.estimated, false);
  assert.ok(outlook.daysUntil! > 0);
  // The whole point of a line rather than a seasonal tab: the useful window is BEFORE the list.
  assert.match(outlook.message, /before the list/);
});

test('between announcement and deadline it points at the applications', () => {
  const outlook = outlookAt('2026-03-01T00:00:00Z');
  assert.equal(outlook.phase, 'applications');
  assert.ok(outlook.daysUntil! > 0);
});

test('during coding it points at next year', () => {
  const outlook = outlookAt('2026-07-01T00:00:00Z');
  assert.equal(outlook.phase, 'coding');
  assert.match(outlook.message, /2027/);
});

test('after coding ends, the cycle rolls to the next year and is marked estimated', () => {
  const outlook = outlookAt('2026-09-15T00:00:00Z');
  assert.equal(outlook.year, 2027);
  assert.equal(outlook.phase, 'before-announcement');
  // Only 2026's dates are published. Presenting an inferred February date as fact would be exactly
  // the kind of confident-but-unverified claim this project refuses elsewhere.
  assert.equal(outlook.estimated, true);
  assert.match(outlook.message, /estimated/);
});

test('a future year is always flagged as estimated', () => {
  assert.equal(outlookAt('2028-01-05T00:00:00Z').estimated, true);
  assert.equal(outlookAt('2026-01-05T00:00:00Z').estimated, false);
});

test('the published 2026 dates are the ones recorded', () => {
  // These came from the programme's own timeline; if they are ever edited, it should be a deliberate
  // act with a source, not a drift.
  assert.equal(GSOC_2026.orgsAnnounced, '2026-02-19');
  assert.equal(GSOC_2026.applicationsClose, '2026-03-31');
  assert.equal(GSOC_2026.codingEnds, '2026-08-23');
});

test('every day of the year yields a phase and a message', () => {
  // Guards the boundary arithmetic: an off-by-one at a milestone would leave a day with no branch
  // matching, and the fallback would silently claim the wrong year.
  for (let day = 0; day < 365; day += 1) {
    const now = new Date(Date.UTC(2026, 0, 1) + day * 86_400_000);
    const outlook = gsocOutlook(now);
    assert.ok(outlook.message.length > 20, `no message for ${now.toISOString()}`);
    assert.ok(
      ['before-announcement', 'applications', 'coding', 'between'].includes(outlook.phase),
    );
  }
});
