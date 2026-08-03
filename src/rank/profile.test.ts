import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EMPTY_PROFILE,
  MAX_PREFERENCE_POINTS,
  parseProfile,
  ProfileError,
  resolveProfile,
} from './profile.ts';
import { scoreCandidate, type Candidate } from './score.ts';
import { LANGUAGE_POINTS } from './weights.ts';

const NOW = new Date('2026-08-01T00:00:00Z');

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    issueId: 1,
    repoFullName: 'owner/name',
    number: 1,
    title: 'Something',
    labels: [],
    commentCount: 1,
    createdAtGh: new Date(NOW.getTime() - 60 * 86_400_000).toISOString(),
    authorAssociation: 'NONE',
    bodyLength: 400,
    htmlUrl: 'https://example.invalid/1',
    primaryLanguage: 'TypeScript',
    topics: [],
    stars: 5000,
    responsiveness: 'responsive',
    confidence: 'high',
    medianHoursResponse: 6,
    noResponseRate: 0.1,
    mergeRate: 0.8,
    mergedPrs: 20,
    closedUnmergedPrs: 4,
    setupWeight: 'light',
    composeServices: null,
    envVarCount: 2,
    hasDevcontainer: false,
    taskRunner: 'make',
    hasContributing: true,
    ciRunsOnPr: true,
    ...overrides,
  };
}

const lineFor = (c: Candidate, signal: string, profile = resolveProfile()) =>
  scoreCandidate(c, NOW, undefined, profile).lines.find((line) => line.signal === signal);

// ---------------------------------------------------------------------------
// defaults
// ---------------------------------------------------------------------------

test('an empty profile scores exactly as the weights file did before it existed', () => {
  const before = scoreCandidate(candidate(), NOW);
  const after = scoreCandidate(candidate(), NOW, undefined, resolveProfile(EMPTY_PROFILE));
  assert.deepEqual(after, before);
  assert.equal(lineFor(candidate(), 'language')?.points, LANGUAGE_POINTS['TypeScript']);
});

test('setting any language replaces the defaults wholesale rather than merging', () => {
  // A merge would mean deleting TypeScript in the settings screen silently reinstates its default,
  // which is the opposite of what deleting it means.
  const profile = resolveProfile({ ...EMPTY_PROFILE, languagePoints: { Rust: 20 } });
  assert.equal(lineFor(candidate({ primaryLanguage: 'Rust' }), 'language', profile)?.points, 20);
  assert.equal(
    lineFor(candidate({ primaryLanguage: 'TypeScript' }), 'language', profile),
    undefined,
    'TypeScript scored 14 by default and must score nothing once the profile omits it',
  );
});

test('an unlisted language is a zero, not a penalty', () => {
  const profile = resolveProfile({ ...EMPTY_PROFILE, languagePoints: { Rust: 20 } });
  const line = lineFor(candidate({ primaryLanguage: 'COBOL' }), 'language', profile);
  assert.equal(line, undefined, 'an unfamiliar language is a cost, not a disqualification');
});

test('language matching ignores casing', () => {
  const profile = resolveProfile({ ...EMPTY_PROFILE, languagePoints: { typescript: 9 } });
  assert.equal(lineFor(candidate({ primaryLanguage: 'TypeScript' }), 'language', profile)?.points, 9);
});

// ---------------------------------------------------------------------------
// topics
// ---------------------------------------------------------------------------

test('topics score nothing until the profile names them', () => {
  assert.equal(lineFor(candidate({ topics: ['react', 'frontend'] }), 'topic'), undefined);
});

test('a matched topic scores and says which one', () => {
  const profile = resolveProfile({ ...EMPTY_PROFILE, topicPoints: { react: 8 } });
  const line = lineFor(candidate({ topics: ['react', 'frontend'] }), 'topic', profile);
  assert.equal(line?.points, 8);
  assert.match(line!.detail, /react/);
  assert.equal(line!.about, 'repo', 'a topic describes the project, not the issue');
});

test('several matching topics pay once, at the best rate', () => {
  // Otherwise a repo tagged react + typescript + frontend collects three payments for one fact
  // about itself, and out-ranks a better project that happens to carry fewer tags.
  const profile = resolveProfile({
    ...EMPTY_PROFILE,
    topicPoints: { react: 8, frontend: 5, typescript: 3 },
  });
  const line = lineFor(candidate({ topics: ['react', 'frontend', 'typescript'] }), 'topic', profile);
  assert.equal(line?.points, 8);
});

test('an avoided topic subtracts and names itself', () => {
  const profile = resolveProfile({ ...EMPTY_PROFILE, avoidTopics: ['Blockchain'] });
  const line = lineFor(candidate({ topics: ['blockchain'] }), 'avoided subject', profile);
  assert.ok(line !== undefined && line.points < 0);
  assert.match(line.detail, /blockchain/);
});

test('profile avoid-labels extend the built-in list rather than replacing it', () => {
  // The built-ins encode structural problems — needs-design, blocked — that are worth avoiding
  // whatever you happen to like.
  const profile = resolveProfile({ ...EMPTY_PROFILE, avoidLabels: ['legacy'] });
  assert.ok(lineFor(candidate({ labels: ['legacy'] }), 'avoid', profile) !== undefined);
  assert.ok(
    lineFor(candidate({ labels: ['needs design'] }), 'avoid', profile) !== undefined,
    'a built-in avoid term must survive a profile that lists its own',
  );
});

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

test('a well-formed profile round-trips', () => {
  const parsed = parseProfile({
    languagePoints: { TypeScript: 14 },
    topicPoints: { react: 8 },
    avoidTopics: ['blockchain'],
    avoidLabels: ['legacy'],
    minStars: 500,
    maxStars: 30000,
    maxSetupWeight: 'moderate',
  });
  assert.equal(parsed.minStars, 500);
  assert.equal(parsed.maxSetupWeight, 'moderate');
  assert.deepEqual(parsed.avoidTopics, ['blockchain']);
});

test('missing fields become the empty profile, not an error', () => {
  assert.deepEqual(parseProfile({}), EMPTY_PROFILE);
});

test('points beyond the ceiling are refused with the reason', () => {
  // A preference that outranks every measured signal turns the ranking into a filter, and the
  // shortlist already has real filters.
  assert.throws(
    () => parseProfile({ languagePoints: { Rust: MAX_PREFERENCE_POINTS + 1 } }),
    (error: Error) => error instanceof ProfileError && /±25/.test(error.message),
  );
  assert.doesNotThrow(() => parseProfile({ languagePoints: { Rust: MAX_PREFERENCE_POINTS } }));
  assert.doesNotThrow(() => parseProfile({ languagePoints: { Rust: -MAX_PREFERENCE_POINTS } }));
});

test('a non-numeric points value is refused rather than read as zero', () => {
  // Coercing it would quietly change every ranking with nothing appearing wrong.
  assert.throws(() => parseProfile({ languagePoints: { Rust: 'fourteen' } }), ProfileError);
  assert.throws(() => parseProfile({ languagePoints: { Rust: null } }), ProfileError);
  assert.throws(() => parseProfile({ languagePoints: { Rust: 3.5 } }), /whole number/);
});

test('an empty language name is refused', () => {
  assert.throws(() => parseProfile({ languagePoints: { '  ': 5 } }), /empty name/);
});

test('an inverted star band is refused', () => {
  assert.throws(() => parseProfile({ minStars: 5000, maxStars: 500 }), /cannot exceed/);
  assert.doesNotThrow(() => parseProfile({ minStars: 500, maxStars: 500 }));
});

test('a negative or fractional star count is refused', () => {
  assert.throws(() => parseProfile({ minStars: -1 }), ProfileError);
  assert.throws(() => parseProfile({ minStars: 1.5 }), ProfileError);
});

test('an unknown setup weight is refused', () => {
  assert.throws(() => parseProfile({ maxSetupWeight: 'trivial' }), /light, moderate, heavy/);
  assert.deepEqual(parseProfile({ maxSetupWeight: '' }).maxSetupWeight, null);
});

test('blank and duplicate terms are dropped', () => {
  const parsed = parseProfile({ avoidTopics: ['  blockchain ', '', 'blockchain', '   '] });
  assert.deepEqual(parsed.avoidTopics, ['blockchain']);
});

test('a list where an object belongs is refused', () => {
  assert.throws(() => parseProfile({ languagePoints: ['TypeScript'] }), /must be an object/);
  assert.throws(() => parseProfile({ avoidTopics: 'blockchain' }), /must be a list/);
  assert.throws(() => parseProfile(null), /Expected an object/);
});
