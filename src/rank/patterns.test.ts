import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildRepoPatterns,
  MIN_PATTERN_DECISIONS,
  MIN_REASON_REPEATS,
  normaliseReason,
  type DecidedIssue,
} from './patterns.ts';

function decided(overrides: Partial<DecidedIssue> = {}): DecidedIssue {
  return {
    repoFullName: 'acme/widgets',
    latestVerdict: 'rejected',
    reason: null,
    ...overrides,
  };
}

test('a single negative decision is not a pattern', () => {
  const patterns = buildRepoPatterns([decided()]);
  assert.equal(patterns.size, 0);
});

test('two rejections in one repo make a pattern, counted separately from unlanded work', () => {
  const patterns = buildRepoPatterns([
    decided(),
    decided({ latestVerdict: 'closed_unmerged' }),
    decided({ latestVerdict: 'abandoned' }),
  ]);

  const pattern = patterns.get('acme/widgets');
  assert.ok(pattern);
  assert.equal(pattern.declined, 1);
  // abandoned and closed_unmerged are both work that never landed, which is the more expensive kind
  // of wrong and so is reported apart from a decision not to start.
  assert.equal(pattern.unlanded, 2);
});

test('MIN_PATTERN_DECISIONS is the threshold, and it counts both kinds together', () => {
  assert.equal(MIN_PATTERN_DECISIONS, 2);
  const oneEach = buildRepoPatterns([decided(), decided({ latestVerdict: 'stalled' })]);
  assert.ok(oneEach.get('acme/widgets'));
});

/**
 * The point of the whole feature: not "you rejected six things here" but "you rejected six things
 * here for the same reason".
 */
test('a reason repeating across issues is surfaced with its count', () => {
  const patterns = buildRepoPatterns([
    decided({ reason: 'Needs design discussion first' }),
    decided({ reason: 'needs design discussion first.' }),
    decided({ reason: 'needs  design   discussion first' }),
    decided({ reason: 'too large' }),
  ]);

  const repeated = patterns.get('acme/widgets')?.repeatedReason;
  assert.ok(repeated);
  assert.equal(repeated.count, 3);
  // Verbatim, and specifically the most recently written phrasing — callers pass newest first. A
  // normalised reason shown back to you reads like the tool paraphrasing your own note.
  assert.equal(repeated.reason, 'Needs design discussion first');
});

test('a reason used once is not called repeated', () => {
  assert.equal(MIN_REASON_REPEATS, 2);
  const patterns = buildRepoPatterns([
    decided({ reason: 'too large' }),
    decided({ reason: 'wrong shape of work' }),
  ]);
  assert.equal(patterns.get('acme/widgets')?.repeatedReason, null);
});

test('positive and in-progress outcomes contribute nothing', () => {
  const patterns = buildRepoPatterns([
    decided({ latestVerdict: 'merged' }),
    decided({ latestVerdict: 'merged' }),
    decided({ latestVerdict: 'submitted' }),
    decided({ latestVerdict: 'started' }),
    decided({ latestVerdict: 'shortlisted' }),
  ]);
  assert.equal(patterns.size, 0, 'a productive repo must not be described as having a pattern');
});

test('repos are kept apart', () => {
  const patterns = buildRepoPatterns([
    decided({ repoFullName: 'a/one' }),
    decided({ repoFullName: 'a/one' }),
    decided({ repoFullName: 'b/two' }),
  ]);
  assert.equal(patterns.get('a/one')?.declined, 2);
  assert.equal(patterns.get('b/two'), undefined);
});

test('normaliseReason tidies without interpreting', () => {
  assert.equal(normaliseReason('  Needs   DESIGN discussion first.  '), 'needs design discussion first');
  // Interior punctuation is left alone: it carries meaning, and stripping it would merge reasons that
  // are genuinely different.
  assert.equal(normaliseReason("won't fix, upstream bug"), "won't fix, upstream bug");
  // Nothing stemming-like. These stay separate because a reader can predict that they will.
  assert.notEqual(normaliseReason('needs design'), normaliseReason('design needed'));
});

test('a blank reason does not become a group of its own', () => {
  const patterns = buildRepoPatterns([
    decided({ reason: '   ' }),
    decided({ reason: '' }),
    decided({ reason: null }),
  ]);
  assert.equal(patterns.get('acme/widgets')?.declined, 3);
  assert.equal(patterns.get('acme/widgets')?.repeatedReason, null);
});
