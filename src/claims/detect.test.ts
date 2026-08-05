import assert from 'node:assert/strict';
import { test } from 'node:test';
import { latestCheckValues } from '../schema_constraints.ts';
import {
  bountyLabels,
  CLAIM_FRESH_DAYS,
  CLAIM_VERDICTS,
  detectClaims,
  type ClaimComment,
} from './detect.ts';

const NOW = new Date('2026-08-04T00:00:00Z');
const daysAgo = (days: number): string =>
  new Date(NOW.getTime() - days * 86_400_000).toISOString();

function comment(overrides: Partial<ClaimComment> = {}): ClaimComment {
  return {
    author: 'someone',
    authorType: 'User',
    authorAssociation: 'NONE',
    body: 'Nice idea.',
    createdAt: daysAgo(1),
    ...overrides,
  };
}

const detect = (comments: ClaimComment[], commentsTotal = comments.length) =>
  detectClaims({ comments, commentsTotal, now: NOW });

test('CLAIM_VERDICTS matches the issue_claims constraint', () => {
  const allowed = latestCheckValues('issue_claims', 'verdict');
  assert.ok(allowed, 'no issue_claims verdict constraint found in any migration');
  assert.deepEqual([...allowed].sort(), [...CLAIM_VERDICTS].sort());
});

// ------------------------------------------------------------------ the basics

test('a thread with no intent is free', () => {
  const found = detect([comment({ body: 'This also happens on Windows.' })]);
  assert.equal(found.verdict, 'free');
  assert.equal(found.claimants, 0);
});

test('one recent request is claimed, and the reason is recorded', () => {
  const found = detect([comment({ author: 'ada', body: 'Can I work on this?' })]);
  assert.equal(found.verdict, 'claimed');
  assert.equal(found.claimants, 1);
  assert.equal(found.claims[0]?.author, 'ada');
  // Every verdict has to be checkable against the thread that produced it.
  assert.match(found.claims[0]!.why, /asked to take it/);
  assert.match(found.claims[0]!.excerpt, /Can I work on this/);
});

/**
 * The case the whole feature exists for: a `good first issue` where twenty people have asked and
 * nobody has been assigned. GitHub's assignee field is empty, so the shortlist calls this free work.
 */
test('several people asking with nobody assigned is contested', () => {
  const found = detect([
    comment({ author: 'ada', body: 'Can I work on this?' }),
    comment({ author: 'brendan', body: 'I would like to work on this issue.' }),
    comment({ author: 'grace', body: 'please assign this to me' }),
  ]);
  assert.equal(found.verdict, 'contested');
  assert.equal(found.claimants, 3);
});

test('the same person asking three times is one claimant', () => {
  const found = detect([
    comment({ author: 'ada', body: 'Can I work on this?' }),
    comment({ author: 'ada', body: 'assign me please' }),
    comment({ author: 'ada', body: 'I would like to work on this' }),
  ]);
  assert.equal(found.claimants, 1);
  assert.equal(found.verdict, 'claimed');
});

test('reported work outranks everything else', () => {
  const found = detect([
    comment({ author: 'ada', body: 'Can I work on this?' }),
    comment({ author: 'brendan', body: 'Can I work on this?' }),
    comment({ author: 'grace', body: 'I have pushed a fix, PR is up.' }),
  ]);
  // Somebody with work in flight settles the question, however many people asked.
  assert.equal(found.verdict, 'in-progress');
  assert.equal(found.progress.length, 1);
});

test('a linked pull request alone is enough for in-progress', () => {
  const found = detect([
    comment({ body: 'See https://github.com/acme/widgets/pull/412 for the fix.' }),
  ]);
  assert.equal(found.verdict, 'in-progress');
  assert.deepEqual(found.linkedPrs, ['https://github.com/acme/widgets/pull/412']);
});

// -------------------------------------------------------------- staleness

/**
 * An intention does not survive forever. Someone who asked five weeks ago and pushed nothing has moved
 * on, and reporting the issue as claimed would hide work that is available.
 */
test('an old request with no work becomes a stale claim', () => {
  const found = detect([
    comment({ author: 'ada', body: 'Can I work on this?', createdAt: daysAgo(CLAIM_FRESH_DAYS + 10) }),
  ]);
  assert.equal(found.verdict, 'stale-claim');
  assert.equal(found.claimants, 1);
});

test('reported work does not go stale on the intent clock', () => {
  // A half-finished branch does not evaporate the way an intention does.
  const found = detect([
    comment({ author: 'ada', body: 'I opened a PR for this.', createdAt: daysAgo(200) }),
  ]);
  assert.equal(found.verdict, 'in-progress');
});

test('one fresh request among old ones keeps the issue claimed', () => {
  const found = detect([
    comment({ author: 'ada', body: 'Can I work on this?', createdAt: daysAgo(90) }),
    comment({ author: 'ada', body: 'still interested, may I take this?', createdAt: daysAgo(2) }),
  ]);
  assert.equal(found.verdict, 'claimed');
});

// ----------------------------------------------- the false positives that matter

/**
 * These are the sentences that appear in every busy issue thread. Each one would match a claim pattern
 * without the veto list, and each would produce a false "claimed" — which costs you an option you
 * never learn you had.
 */
test('asking whether anyone else is working on it is not a claim', () => {
  for (const body of [
    'Is anyone working on this?',
    'is anybody already working on this issue?',
    'Is someone working on this, or is it free?',
    'Who is working on this?',
    'Has anyone been assigned to this yet?',
  ]) {
    assert.equal(detect([comment({ body })]).verdict, 'free', body);
  }
});

test('a maintainer delegating is not a claim', () => {
  for (const body of [
    '@ada can you take this one?',
    'Can someone work on this before the release?',
    'can you handle this?',
  ]) {
    assert.equal(detect([comment({ body, authorAssociation: 'MEMBER' })]).verdict, 'free', body);
  }
});

test('a maintainer chasing a stale claim is not itself a claim', () => {
  const found = detect([
    comment({ author: 'maintainer', body: 'Are you still working on this?', authorAssociation: 'OWNER' }),
  ]);
  assert.equal(found.verdict, 'free');
});

test('offering to look is not offering to do', () => {
  // "I'll take a look" is the single most common comment on an open issue and means neither intent nor
  // work. Matching on "take" would have caught it.
  for (const body of ["I'll take a look", 'I will take a look at this later', 'Taking a look now']) {
    assert.equal(detect([comment({ body })]).verdict, 'free', body);
  }
});

test('a conditional offer is still a claim', () => {
  // Deliberately NOT vetoed: this person is volunteering, and treating it as a question would produce
  // a false "free", which is the expensive direction.
  const found = detect([
    comment({ author: 'ada', body: 'I would like to work on this if nobody else is on it.' }),
  ]);
  assert.equal(found.verdict, 'claimed');
});

test('bots are ignored', () => {
  const found = detect([
    comment({ author: 'stale-bot', authorType: 'Bot', body: 'This issue is stale. /assign me' }),
    comment({ author: null, authorType: 'Bot', body: 'Can I work on this?' }),
  ]);
  assert.equal(found.verdict, 'free');
  assert.equal(found.claimants, 0);
});

/**
 * A real human login ending in "bot" must not be filtered out. `klembot` is a person, and discovering
 * that cost this project a round of corrected metrics.
 */
test('a human whose login ends in bot still counts', () => {
  const found = detect([
    comment({ author: 'klembot', authorType: 'User', body: 'Can I work on this?' }),
  ]);
  assert.equal(found.claimants, 1);
});

// ------------------------------------------------------------------ coverage

test('a partially read thread reports how much it saw', () => {
  const found = detect([comment({ body: 'hello' })], 412);
  assert.equal(found.commentsRead, 1);
  assert.equal(found.commentsTotal, 412);
  // The caller decides what to say about the gap; the detector's job is to make it visible.
});

test('slash-assign is recognised on its own line only', () => {
  assert.equal(detect([comment({ author: 'a', body: '/assign' })]).verdict, 'claimed');
  assert.equal(detect([comment({ author: 'a', body: '/assign me' })]).verdict, 'claimed');
  // Prose about the command is not the command.
  assert.equal(
    detect([comment({ body: 'You can use /assign me to claim issues in this repo.' })]).verdict,
    'free',
  );
});

// ------------------------------------------------------------------- bounties

test('bounty hints are picked out of comments', () => {
  assert.equal(detect([comment({ body: '/bounty $200' })]).bountyHint, '/bounty command');
  assert.equal(detect([comment({ body: 'There is a bounty on this' })]).bountyHint, 'bounty mentioned');
  assert.equal(detect([comment({ body: 'no money here' })]).bountyHint, null);
});

test('bounty labels are recognised without any fetch, and narrowly', () => {
  assert.deepEqual(bountyLabels(['bug', 'bounty', 'good first issue']), ['bounty']);
  assert.deepEqual(bountyLabels(['$100', 'reward']), ['$100', 'reward']);
  // `help wanted` is not a bounty, and `paid-plan` is a product label on plenty of SaaS repositories.
  assert.deepEqual(bountyLabels(['help wanted', 'paid-plan', 'documentation']), []);
});
