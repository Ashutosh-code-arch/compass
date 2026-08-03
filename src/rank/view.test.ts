import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Candidate } from './score.ts';
import {
  assembleShortlist,
  buildRepoContext,
  buildWhyView,
  hoursRatio,
  median,
  MIN_PAIRS_FOR_MEAN,
  summariseJournal,
  type JournalEntry,
} from './view.ts';

const NOW = new Date('2026-07-31T00:00:00Z');
const DAY = 86_400_000;

/**
 * A candidate that scores well above the default threshold, so tests can exercise the assembly
 * without also having to reason about the weights.
 */
function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    issueId: 1,
    repoFullName: 'owner/name',
    number: 1,
    title: 'Something',
    labels: ['good first issue'],
    commentCount: 2,
    createdAtGh: new Date(NOW.getTime() - 100 * DAY).toISOString(),
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

/** n candidates in one repo, distinct issue numbers, otherwise identical. */
function repoWith(fullName: string, count: number): Candidate[] {
  return Array.from({ length: count }, (_unused, index) =>
    candidate({
      repoFullName: fullName,
      issueId: Math.abs(hash(fullName)) + index,
      number: index + 1,
      // Vary the age slightly so the scores are not all identical, which would make the ordering
      // assertions depend on sort stability rather than on the cap.
      createdAtGh: new Date(NOW.getTime() - (100 + index) * DAY).toISOString(),
    }),
  );
}

function hash(value: string): number {
  let out = 0;
  for (const char of value) out = (out * 31 + char.charCodeAt(0)) | 0;
  return out;
}

// ---------------------------------------------------------------------------
// shortlist assembly
// ---------------------------------------------------------------------------

test('an empty candidate set is a result, not an error', () => {
  const view = assembleShortlist([], { now: NOW });
  assert.deepEqual(view.rows, []);
  assert.deepEqual(view.notices, [{ kind: 'no-candidates' }]);
  assert.equal(view.summary.considered, 0);
  assert.equal(view.summary.scoreRange, null);
});

test('candidates that all score below the threshold report the threshold that excluded them', () => {
  const view = assembleShortlist([candidate()], { minScore: 10_000, now: NOW });
  assert.deepEqual(view.rows, []);
  assert.deepEqual(view.notices, [
    { kind: 'none-scoring', considered: 1, minScore: 10_000 },
  ]);
  // The count of what was looked at survives even when nothing qualified.
  assert.equal(view.summary.considered, 1);
});

test('one repo cannot take over the list', () => {
  // The failure this guards: twelve of a real top twenty came from a single repository, all on an
  // identical score, because repo-level signals dominate.
  const view = assembleShortlist(repoWith('hog/monopoly', 12), { perRepo: 2, now: NOW });

  assert.equal(view.rows.length, 2);
  assert.equal(view.summary.repos, 1);
  // The other ten still scored; they were held back, not discarded.
  assert.equal(view.summary.scoring, 12);
  assert.equal(view.rows[0]!.heldBackInRepo, 10);
  assert.equal(view.rows[1]!.heldBackInRepo, 10);
});

test('the cap applies per repo, so a mixed set fills up to the limit', () => {
  const view = assembleShortlist(
    [...repoWith('a/one', 5), ...repoWith('b/two', 5), ...repoWith('c/three', 5)],
    { perRepo: 2, limit: 6, now: NOW },
  );

  assert.equal(view.rows.length, 6);
  assert.equal(view.summary.repos, 3);
  const perRepo = new Map<string, number>();
  for (const row of view.rows) {
    perRepo.set(row.issue.repoFullName, (perRepo.get(row.issue.repoFullName) ?? 0) + 1);
  }
  assert.deepEqual([...perRepo.values()], [2, 2, 2]);
});

test('paging walks the capped list without repeating or skipping a row', () => {
  const corpus = [...repoWith('a/one', 5), ...repoWith('b/two', 5), ...repoWith('c/three', 5)];
  const page = (offset: number) =>
    assembleShortlist(corpus, { perRepo: 2, limit: 2, offset, now: NOW });

  const first = page(0);
  assert.equal(first.summary.total, 6, 'three repos capped at two each');
  assert.equal(first.summary.shown, 2);

  const seen: string[] = [];
  for (let offset = 0; offset < first.summary.total; offset += 2) {
    seen.push(...page(offset).rows.map((row) => `${row.issue.repoFullName}#${row.issue.number}`));
  }
  assert.equal(seen.length, 6);
  assert.equal(new Set(seen).size, 6, 'a row appeared on two pages');
});

test('total counts the capped list, not everything that scored', () => {
  // Paging over `scoring` would run off the end: 12 issues in one repo offer 2 pageable rows.
  const view = assembleShortlist(repoWith('hog/monopoly', 12), { perRepo: 2, limit: 5, now: NOW });
  assert.equal(view.summary.scoring, 12);
  assert.equal(view.summary.total, 2);
  assert.equal(view.summary.shown, 2);
});

test('ranks are absolute positions, so page two does not restart at one', () => {
  const corpus = [...repoWith('a/one', 4), ...repoWith('b/two', 4)];
  const second = assembleShortlist(corpus, { perRepo: 2, limit: 2, offset: 2, now: NOW });
  assert.deepEqual(second.rows.map((row) => row.rank), [3, 4]);
});

test('an offset past the end is an empty page, not an error', () => {
  const view = assembleShortlist(repoWith('a/one', 4), { perRepo: 2, limit: 5, offset: 99, now: NOW });
  assert.deepEqual(view.rows, []);
  assert.equal(view.summary.total, 2, 'the count still reports what exists');
  assert.equal(view.summary.shown, 0);
});

test('a negative offset is clamped rather than slicing from the end', () => {
  const view = assembleShortlist(repoWith('a/one', 4), { perRepo: 2, limit: 1, offset: -3, now: NOW });
  assert.equal(view.rows.length, 1);
  assert.equal(view.rows[0]!.rank, 1);
});

test('heldBackInRepo counts the whole ranking, not just the first page', () => {
  // It used to count only what had been walked before the limit was reached, which made the number
  // depend on the page size — "+3 more" on page one and "+7 more" on page two, for the same repo.
  const view = assembleShortlist(repoWith('hog/monopoly', 12), { perRepo: 2, limit: 1, now: NOW });
  assert.equal(view.rows[0]!.heldBackInRepo, 10);
});

test('ranks are contiguous from one and follow the score order', () => {
  const view = assembleShortlist([...repoWith('a/one', 3), ...repoWith('b/two', 3)], {
    perRepo: 3,
    now: NOW,
  });

  assert.deepEqual(
    view.rows.map((row) => row.rank),
    view.rows.map((_unused, index) => index + 1),
  );
  const scores = view.rows.map((row) => row.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
});

test('heldBackInRepo is zero when the cap never bit', () => {
  const view = assembleShortlist(repoWith('a/one', 2), { perRepo: 5, now: NOW });
  assert.equal(view.rows.length, 2);
  assert.ok(view.rows.every((row) => row.heldBackInRepo === 0));
});

test('reaching the fetch cap is reported, because the ranking then saw a subset', () => {
  // At the old default of 4,000 a large corpus was silently ranked on whichever rows happened to be
  // most recently updated. Hitting the cap has to be visible.
  const view = assembleShortlist(repoWith('a/one', 3), { fetchLimit: 3, perRepo: 3, now: NOW });
  assert.deepEqual(view.notices, [{ kind: 'fetch-cap-hit', fetchLimit: 3 }]);
  assert.equal(view.rows.length, 3);
});

test('staying under the fetch cap produces no notice', () => {
  const view = assembleShortlist(repoWith('a/one', 3), { fetchLimit: 50, perRepo: 3, now: NOW });
  assert.deepEqual(view.notices, []);
});

test('the score range is computed over everything that scored, not over what is shown', () => {
  const view = assembleShortlist(repoWith('a/one', 10), { perRepo: 1, limit: 1, now: NOW });
  assert.equal(view.rows.length, 1);
  assert.equal(view.summary.scoring, 10);
  const range = view.summary.scoreRange;
  assert.ok(range !== null);
  // A single shown row cannot be both ends of a ten-row distribution.
  assert.ok(range.max >= range.min);
  assert.equal(range.max, view.rows[0]!.score);
});

test('rows carry issue-level evidence only, so two rows in a repo differ', () => {
  const view = assembleShortlist(repoWith('a/one', 2), { perRepo: 2, now: NOW });
  for (const row of view.rows) {
    assert.ok(
      row.evidence.every((line) => line.about === 'issue'),
      'repo lines are identical for every issue in a project and belong on the context line',
    );
  }
});

test('row context reports raw values, leaving null as null', () => {
  const view = assembleShortlist(
    [candidate({ setupWeight: null, medianHoursResponse: null, primaryLanguage: null })],
    { now: NOW },
  );
  const context = view.rows[0]!.context;
  assert.equal(context.setupWeight, null);
  assert.equal(context.medianHoursResponse, null);
  assert.equal(context.primaryLanguage, null);
  // An unmeasured value must never arrive at a renderer as a zero.
  assert.notEqual(context.medianHoursResponse, 0);
});

test('row subtotals split the whole score, not just the displayed evidence', () => {
  const view = assembleShortlist([candidate()], { now: NOW });
  const row = view.rows[0]!;
  assert.equal(row.subtotals.repo + row.subtotals.issue, row.score);
  // The point of carrying them: the four displayed lines are capped and cannot be summed to this.
  assert.ok(row.subtotals.repo > 0 && row.subtotals.issue > 0);
});

test('a row ranked on its project is distinguishable from one ranked on its issue', () => {
  const onProject = assembleShortlist([candidate({ labels: [], commentCount: 40 })], {
    minScore: -1000,
    now: NOW,
  }).rows[0]!;
  const onIssue = assembleShortlist([candidate()], { minScore: -1000, now: NOW }).rows[0]!;
  assert.ok(
    onIssue.subtotals.issue > onProject.subtotals.issue,
    'an invited, uncontested issue should carry more issue-level weight than an ignored one',
  );
  assert.equal(onProject.subtotals.repo, onIssue.subtotals.repo, 'same repo, same project subtotal');
});

test('median takes the midpoint of an even-length set', () => {
  assert.equal(median([1, 2, 3]), 2);
  assert.equal(median([1, 2, 3, 4]), 3);
  assert.equal(median([4, 1, 3, 2]), 3);
  assert.equal(median([7]), 7);
});

test('repo context depends only on that repo, which is what lets `why` scope its query', () => {
  // The optimisation: `why` fetches one repository's candidates rather than the whole corpus. That
  // is only sound because buildRepoContext derives each entry from that repo's issues alone. If a
  // future signal reads across repositories, this test fails and the scoped query must go back.
  const mine = repoWith('a/one', 4);
  const others = [...repoWith('b/two', 30), ...repoWith('c/three', 30)];

  const scoped = buildRepoContext(mine, NOW).get('a/one');
  const unscoped = buildRepoContext([...mine, ...others], NOW).get('a/one');
  assert.deepEqual(scoped, unscoped);
});

// ---------------------------------------------------------------------------
// why
// ---------------------------------------------------------------------------

test('why separates the project from the issue and each subtotal sums its own lines', () => {
  const one = candidate();
  const view = buildWhyView(one, buildRepoContext([one], NOW).get(one.repoFullName), NOW);

  assert.ok(view.repoLines.every((line) => line.about === 'repo'));
  assert.ok(view.issueLines.every((line) => line.about === 'issue'));
  assert.equal(
    view.repoSubtotal,
    view.repoLines.reduce((sum, line) => sum + line.points, 0),
  );
  assert.equal(
    view.issueSubtotal,
    view.issueLines.reduce((sum, line) => sum + line.points, 0),
  );
  assert.equal(view.repoSubtotal + view.issueSubtotal, view.score);
});

test('why sorts each group by points descending', () => {
  const one = candidate();
  const view = buildWhyView(one, undefined, NOW);
  for (const group of [view.repoLines, view.issueLines]) {
    const points = group.map((line) => line.points);
    assert.deepEqual(points, [...points].sort((a, b) => b - a));
  }
});

test('why keeps the unmeasured signals rather than scoring them as zero', () => {
  const view = buildWhyView(
    candidate({ responsiveness: null, setupWeight: null, mergeRate: null }),
    undefined,
    NOW,
  );
  assert.ok(view.unmeasured.length > 0);
  assert.ok(
    view.repoLines.every((line) => line.points !== 0),
    'a missing measurement should be absent from the breakdown, not a zero-point line',
  );
});

// ---------------------------------------------------------------------------
// journal
// ---------------------------------------------------------------------------

function entry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  const predictedHours = overrides.predictedHours ?? null;
  const actualHours = overrides.actualHours ?? null;
  return {
    repoFullName: 'owner/name',
    number: 1,
    title: 'Something',
    trail: ['started'],
    latestVerdict: 'started',
    predictedHours,
    actualHours,
    ratio: hoursRatio(predictedHours, actualHours),
    reason: null,
    lastAt: NOW.toISOString(),
    ...overrides,
  };
}

test('a prediction without an outcome is not a pair', () => {
  const view = summariseJournal([
    entry({ predictedHours: 4 }),
    entry({ actualHours: 9 }),
    entry(),
  ]);
  assert.equal(view.complete, 0);
  assert.equal(view.meanRatio, null);
});

test('the mean ratio is withheld below the minimum number of pairs', () => {
  const pairs = Array.from({ length: MIN_PAIRS_FOR_MEAN - 1 }, () =>
    entry({ predictedHours: 4, actualHours: 8 }),
  );
  const view = summariseJournal(pairs);
  assert.equal(view.complete, MIN_PAIRS_FOR_MEAN - 1);
  assert.equal(
    view.meanRatio,
    null,
    'an average over one or two ratios is the fabricated precision this project refuses',
  );
});

test('the mean ratio appears once there are enough pairs', () => {
  const view = summariseJournal([
    entry({ predictedHours: 4, actualHours: 8 }), // 2.0
    entry({ predictedHours: 2, actualHours: 2 }), // 1.0
    entry({ predictedHours: 5, actualHours: 15 }), // 3.0
  ]);
  assert.equal(view.complete, 3);
  assert.equal(view.meanRatio, 2);
});

test('incomplete entries are excluded from the mean, not counted as accurate', () => {
  const view = summariseJournal([
    entry({ predictedHours: 4, actualHours: 8 }),
    entry({ predictedHours: 4, actualHours: 8 }),
    entry({ predictedHours: 4, actualHours: 8 }),
    entry({ predictedHours: 4 }),
    entry(),
  ]);
  assert.equal(view.complete, 3);
  assert.equal(view.meanRatio, 2);
});

test('a zero prediction yields no ratio rather than Infinity', () => {
  // Otherwise the journal reports "Infinityx your prediction" with a straight face.
  assert.equal(hoursRatio(0, 9), null);
  assert.equal(hoursRatio(null, 9), null);
  assert.equal(hoursRatio(4, null), null);
  assert.equal(hoursRatio(4, 0), 0);
});

test('an empty journal reports nothing rather than dividing by zero', () => {
  const view = summariseJournal([]);
  assert.deepEqual(view.entries, []);
  assert.equal(view.complete, 0);
  assert.equal(view.meanRatio, null);
});
