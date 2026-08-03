import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyResponsiveness,
  computeMetrics,
  confidenceFor,
  isBotActor,
  isInsider,
  median,
  percentile,
  type PrObservation,
} from './compute.ts';

const NOW = new Date('2026-07-01T00:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Builds a PR relative to NOW so tests read in days-ago terms. */
function pr(overrides: Partial<PrObservation> & { number: number; daysAgo: number }): PrObservation {
  const createdAt = new Date(NOW.getTime() - overrides.daysAgo * DAY).toISOString();
  const { daysAgo: _daysAgo, ...rest } = overrides;
  return {
    authorLogin: 'outsider',
    authorAssociation: 'CONTRIBUTOR',
    authorIsBot: false,
    createdAt,
    mergedAt: null,
    closedAt: null,
    state: 'OPEN',
    firstResponseAt: null,
    firstResponseBy: null,
    firstResponseAssociation: null,
    changesRequested: false,
    lastActionAt: null,
    ...rest,
  };
}

/** Responded `hours` after creation, by a maintainer. */
function responded(base: PrObservation, hours: number): PrObservation {
  const at = new Date(new Date(base.createdAt).getTime() + hours * HOUR).toISOString();
  return {
    ...base,
    firstResponseAt: at,
    firstResponseBy: 'maintainer',
    firstResponseAssociation: 'MEMBER',
    lastActionAt: at,
  };
}

const INPUT = { windowDays: 180, staleDays: 60, now: NOW };

test('median handles odd, even, single and empty', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([7]), 7);
  assert.equal(median([]), null);
});

test('percentile uses nearest-rank', () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(values, 0.9), 9);
  assert.equal(percentile(values, 0.5), 5);
  assert.equal(percentile([42], 0.9), 42);
  assert.equal(percentile([], 0.9), null);
});

test('bot detection covers suffixes, denylist and typename', () => {
  assert.equal(isBotActor('dependabot[bot]'), true);
  assert.equal(isBotActor('renovate[bot]'), true);
  assert.equal(isBotActor('dependabot'), true);
  assert.equal(isBotActor('someone', 'Bot'), true);
  assert.equal(isBotActor('GitHub-Actions'), true, 'denylist should be case-insensitive');
  assert.equal(isBotActor('real-human'), false);
  assert.equal(isBotActor(null), false);
});

test('insider detection', () => {
  for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
    assert.equal(isInsider(association), true, association);
  }
  for (const association of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'NONE']) {
    assert.equal(isInsider(association), false, association);
  }
  assert.equal(isInsider(null), false);
});

test('confidence buckets track sample size', () => {
  assert.equal(confidenceFor(0), 'none');
  assert.equal(confidenceFor(4), 'low');
  assert.equal(confidenceFor(5), 'medium');
  assert.equal(confidenceFor(14), 'medium');
  assert.equal(confidenceFor(15), 'high');
});

test('bot and insider PRs are excluded from the denominator', () => {
  const observations = [
    pr({ number: 1, daysAgo: 10, authorIsBot: true, authorLogin: 'dependabot[bot]', state: 'MERGED', mergedAt: NOW.toISOString() }),
    pr({ number: 2, daysAgo: 10, authorAssociation: 'MEMBER' }),
    pr({ number: 3, daysAgo: 10, authorAssociation: 'OWNER' }),
    responded(pr({ number: 4, daysAgo: 10 }), 5),
  ];
  const metrics = computeMetrics(observations, INPUT);
  assert.equal(metrics.botPrs, 1);
  assert.equal(metrics.insiderPrs, 2);
  assert.equal(metrics.externalPrs, 1, 'only the CONTRIBUTOR PR counts');
});

test('PRs outside the window are dropped', () => {
  const observations = [
    responded(pr({ number: 1, daysAgo: 10 }), 4),
    responded(pr({ number: 2, daysAgo: 400 }), 4),
  ];
  const metrics = computeMetrics(observations, INPUT);
  assert.equal(metrics.prsScanned, 2);
  assert.equal(metrics.prsInWindow, 1);
  assert.equal(metrics.externalPrs, 1);
});

test('merge rate excludes open PRs from the denominator', () => {
  const observations = [
    responded({ ...pr({ number: 1, daysAgo: 30 }), state: 'MERGED', mergedAt: new Date(NOW.getTime() - 29 * DAY).toISOString() }, 2),
    responded({ ...pr({ number: 2, daysAgo: 30 }), state: 'CLOSED', closedAt: new Date(NOW.getTime() - 29 * DAY).toISOString() }, 2),
    responded(pr({ number: 3, daysAgo: 5 }), 2),
    responded(pr({ number: 4, daysAgo: 5 }), 2),
  ];
  const metrics = computeMetrics(observations, INPUT);
  assert.equal(metrics.mergedPrs, 1);
  assert.equal(metrics.closedUnmergedPrs, 1);
  assert.equal(metrics.openPrs, 2);
  assert.equal(metrics.mergeRate, 0.5, '1 merged of 2 decided, not of 4 total');
});

// The trap this whole module exists to avoid.
test('a repo that ignores most outsiders is dormant despite a flattering median', () => {
  const observations: PrObservation[] = [
    responded(pr({ number: 1, daysAgo: 100 }), 1),
    responded(pr({ number: 2, daysAgo: 95 }), 2),
    ...Array.from({ length: 38 }, (_unused, index) =>
      pr({ number: index + 3, daysAgo: 90 - index }),
    ),
  ];
  const metrics = computeMetrics(observations, INPUT);

  assert.equal(metrics.externalPrs, 40);
  assert.equal(metrics.respondedPrs, 2);
  assert.equal(metrics.medianHoursResponse, 1.5, 'median over responders alone looks excellent');
  assert.equal(metrics.noResponseRate, 0.95);
  assert.equal(
    metrics.responsiveness,
    'dormant',
    'the flattering median must not win over the ignore rate',
  );
});

test('a genuinely responsive repo classifies as responsive', () => {
  const observations = Array.from({ length: 20 }, (_unused, index) =>
    responded(
      {
        ...pr({ number: index + 1, daysAgo: index + 1 }),
        state: 'MERGED',
        mergedAt: new Date(NOW.getTime() - index * DAY).toISOString(),
      },
      6,
    ),
  );
  const metrics = computeMetrics(observations, INPUT);
  assert.equal(metrics.confidence, 'high');
  assert.equal(metrics.noResponseRate, 0);
  assert.equal(metrics.medianHoursResponse, 6);
  assert.equal(metrics.responsiveness, 'responsive');
});

test('slow but attentive repos are distinguished from dormant ones', () => {
  const observations = Array.from({ length: 10 }, (_unused, index) =>
    responded(pr({ number: index + 1, daysAgo: index + 20 }), 20 * 24),
  );
  const metrics = computeMetrics(observations, INPUT);
  assert.equal(metrics.noResponseRate, 0, 'everyone got an answer');
  assert.equal(metrics.responsiveness, 'slow', 'but 20 days is slow');
});

test('small samples refuse to classify', () => {
  const metrics = computeMetrics([responded(pr({ number: 1, daysAgo: 3 }), 2)], INPUT);
  assert.equal(metrics.confidence, 'low');
  assert.equal(metrics.responsiveness, 'unknown');
});

test('empty input yields nulls rather than zeros or NaN', () => {
  const metrics = computeMetrics([], INPUT);
  assert.equal(metrics.externalPrs, 0);
  assert.equal(metrics.medianHoursResponse, null);
  assert.equal(metrics.noResponseRate, null);
  assert.equal(metrics.mergeRate, null);
  assert.equal(metrics.confidence, 'none');
  assert.equal(metrics.responsiveness, 'unknown');
});

test('stalled PRs need to be open, unanswered and old', () => {
  const observations = [
    pr({ number: 1, daysAgo: 90 }),
    pr({ number: 2, daysAgo: 5 }),
    responded(pr({ number: 3, daysAgo: 90 }), 3),
    { ...pr({ number: 4, daysAgo: 90 }), state: 'CLOSED' as const, closedAt: NOW.toISOString() },
  ];
  const metrics = computeMetrics(observations, INPUT);
  assert.equal(metrics.openStalePrs, 1, 'only the old, open, unanswered one');
  assert.equal(metrics.openPrs, 3);
});

test('response recorded before creation is clamped, not negative', () => {
  const base = pr({ number: 1, daysAgo: 10 });
  const skewed: PrObservation = {
    ...base,
    firstResponseAt: new Date(new Date(base.createdAt).getTime() - 5 * HOUR).toISOString(),
    firstResponseBy: 'maintainer',
    firstResponseAssociation: 'MEMBER',
    lastActionAt: base.createdAt,
  };
  const metrics = computeMetrics([skewed], INPUT);
  assert.equal(metrics.medianHoursResponse, 0);
});

test('comments-only approval is a sign of life, not dormancy', () => {
  // Prow-based projects (Kubernetes and friends) approve with "/lgtm" comments and let a bot do the
  // merge. Treating only reviews and merges as liveness marked these dormant at a 0% ignore rate.
  const observations = Array.from({ length: 10 }, (_unused, index) => {
    const base = pr({ number: index + 1, daysAgo: index + 10 });
    const at = new Date(new Date(base.createdAt).getTime() + 3 * HOUR).toISOString();
    return {
      ...base,
      firstResponseAt: at,
      firstResponseBy: 'maintainer',
      firstResponseAssociation: 'MEMBER',
      lastActionAt: at,
    };
  });
  const metrics = computeMetrics(observations, INPUT);
  assert.equal(metrics.noResponseRate, 0);
  assert.notEqual(metrics.responsiveness, 'dormant');
  assert.equal(metrics.responsiveness, 'responsive');
});

test('no maintainer action of any kind is still dormant', () => {
  const observations = Array.from({ length: 10 }, (_unused, index) =>
    pr({ number: index + 1, daysAgo: index + 20 }),
  );
  const metrics = computeMetrics(observations, INPUT);
  assert.equal(metrics.hoursSinceLastAction, null);
  assert.equal(metrics.responsiveness, 'dormant');
});

test('a tiny open-PR denominator cannot force dormancy', () => {
  // The real-corpus shape: merges nearly everything within the hour, but has three open PRs, two
  // of them ancient. openStaleRate hits 67% on a denominator of three.
  const merged = Array.from({ length: 20 }, (_unused, index) =>
    responded(
      {
        ...pr({ number: index + 1, daysAgo: index + 10 }),
        state: 'MERGED',
        mergedAt: new Date(NOW.getTime() - (index + 9) * DAY).toISOString(),
      },
      1,
    ),
  );
  const strandedOpen = [pr({ number: 90, daysAgo: 120 }), pr({ number: 91, daysAgo: 130 })];
  const metrics = computeMetrics([...merged, ...strandedOpen, pr({ number: 92, daysAgo: 1 })], INPUT);

  assert.equal(metrics.openPrs, 3);
  assert.equal(metrics.openStaleRate, 0.667);
  assert.equal(metrics.responsiveness, 'responsive', 'good response numbers must win');
});

test('a real backlog of stalled PRs does still mean dormant', () => {
  // Answered PRs are merged and therefore closed, so the open set is genuinely all-stalled rather
  // than diluted by healthy open PRs. This isolates the stale rule from the ignore-rate rule.
  const answered = Array.from({ length: 6 }, (_unused, index) =>
    responded(
      {
        ...pr({ number: index + 1, daysAgo: index + 10 }),
        state: 'MERGED',
        mergedAt: new Date(NOW.getTime() - (index + 9) * DAY).toISOString(),
      },
      2,
    ),
  );
  const stalled = Array.from({ length: 8 }, (_unused, index) =>
    pr({ number: index + 50, daysAgo: 100 + index }),
  );
  const metrics = computeMetrics([...answered, ...stalled], INPUT);

  assert.equal(metrics.openPrs, 8, 'a real denominator');
  assert.equal(metrics.openStaleRate, 1);
  assert.ok((metrics.noResponseRate ?? 0) < 0.6, 'not disqualified by the ignore rate alone');
  assert.equal(metrics.responsiveness, 'dormant', 'the stale backlog is what decides it');
});

test('a median with fewer than three responses refuses to claim a bucket', () => {
  // The observed "0h median, 97% ignored" rows were medians over one data point.
  const observations = [
    responded(pr({ number: 1, daysAgo: 30 }), 0),
    ...Array.from({ length: 6 }, (_unused, index) => pr({ number: index + 2, daysAgo: 20 + index })),
  ];
  const metrics = computeMetrics(observations, INPUT);
  assert.equal(metrics.respondedPrs, 1);
  assert.equal(metrics.medianHoursResponse, 0);
  assert.equal(metrics.noResponseRate, 0.857);
  assert.equal(metrics.responsiveness, 'dormant', 'high ignore rate routes it before the median');

  // Same thin support, but without the disqualifying ignore rate.
  const thin = [
    responded(pr({ number: 1, daysAgo: 30 }), 0),
    responded(pr({ number: 2, daysAgo: 30 }), 0),
    pr({ number: 3, daysAgo: 30 }),
    pr({ number: 4, daysAgo: 2 }),
  ];
  const thinMetrics = computeMetrics(thin, INPUT);
  assert.equal(thinMetrics.respondedPrs, 2);
  assert.equal(thinMetrics.responsiveness, 'unknown', 'two data points is not a measurement');
});

test('classifyResponsiveness prioritises dormancy over speed', () => {
  assert.equal(
    classifyResponsiveness({
      externalPrs: 20,
      respondedPrs: 6,
      openPrs: 2,
      noResponseRate: 0.7,
      medianHoursResponse: 0.5,
      hoursSinceLastAction: 10,
      openStaleRate: 0.1,
    }),
    'dormant',
  );
  assert.equal(
    classifyResponsiveness({
      externalPrs: 20,
      respondedPrs: 18,
      openPrs: 2,
      noResponseRate: 0.1,
      medianHoursResponse: 2,
      hoursSinceLastAction: 100 * 24,
      openStaleRate: 0.1,
    }),
    'dormant',
    'no review in 90 days is dormant regardless of historical speed',
  );
});

// ---------------------------------------------------------------------------
// Calibration fixes, all three found by running against a real corpus
// ---------------------------------------------------------------------------

test('a PR opened this week is too recent to judge, not ignored', () => {
  // Nine answered, three opened in the last few days with no reply yet.
  const observations = [
    ...Array.from({ length: 9 }, (_unused, index) =>
      responded(pr({ number: index + 1, daysAgo: index + 30 }), 5),
    ),
    pr({ number: 100, daysAgo: 1 }),
    pr({ number: 101, daysAgo: 3 }),
    pr({ number: 102, daysAgo: 5 }),
  ];
  const metrics = computeMetrics(observations, INPUT);

  assert.equal(metrics.externalPrs, 12);
  assert.equal(metrics.tooRecentPrs, 3);
  assert.equal(metrics.decidablePrs, 9, 'young unanswered PRs leave the denominator');
  assert.equal(metrics.noResponseRate, 0, 'not 3/12 = 25%');
  assert.equal(metrics.responsiveness, 'responsive');
});

test('the grace period does not excuse genuinely old silence', () => {
  const observations = [
    ...Array.from({ length: 8 }, (_unused, index) => pr({ number: index + 1, daysAgo: 40 + index })),
    responded(pr({ number: 50, daysAgo: 30 }), 4),
    pr({ number: 51, daysAgo: 2 }),
  ];
  const metrics = computeMetrics(observations, INPUT);

  assert.equal(metrics.tooRecentPrs, 1);
  assert.equal(metrics.decidablePrs, 9);
  assert.equal(metrics.noResponseRate, 0.889, '8 of 9 decidable were ignored');
  assert.equal(metrics.responsiveness, 'dormant');
});

test('grace period is configurable and 0 restores the naive denominator', () => {
  const observations = [
    responded(pr({ number: 1, daysAgo: 30 }), 5),
    pr({ number: 2, daysAgo: 1 }),
  ];
  assert.equal(computeMetrics(observations, { ...INPUT, graceDays: 0 }).noResponseRate, 0.5);
  assert.equal(computeMetrics(observations, { ...INPUT, graceDays: 7 }).noResponseRate, 0);
});

test('bot detection catches accounts that are ordinary users', () => {
  // Welcome bots with a MEMBER association and no [bot] suffix, plus known named automation.
  for (const login of [
    'welcome-bot', 'my_bot', 'project-ci', 'ci-runner', 'BOT-deploy',
    'grafanabot', 'k8s-ci-robot', 'openshift-merge-robot', 'mattermod',
  ]) {
    assert.equal(isBotActor(login), true, login);
  }
});

test('bot detection must not swallow humans whose login ends in bot', () => {
  /*
   * Regression. A /bot$/ rule classified these as automation, which discarded a real maintainer's
   * merges and comments and reported an active project as 100% ignored and dormant. klembot is a
   * live example from the corpus: owner of a repo that merges most external PRs.
   */
  for (const login of ['klembot', 'abbot', 'talbot', 'Wilbot', 'elliotbot', 'robot', 'botanist']) {
    assert.equal(isBotActor(login), false, login);
  }
});

test('an explicit ignore list suppresses a responder the heuristics cannot catch', () => {
  // Automation on a normal account with a name that gives nothing away. Undetectable by rule,
  // obvious in the `responders` report, hence the escape hatch.
  assert.equal(isBotActor('triagehelper'), false, 'nothing to key on');
  assert.equal(isBotActor('triagehelper', 'User', new Set(['triagehelper'])), true);
  assert.equal(isBotActor('TriageHelper', 'User', new Set(['triagehelper'])), true, 'case-insensitive');
});

test('a bot first-responder is what made dormant repos look instant', () => {
  // Reproduces the observed shape: median 0h, high ignore rate, verdict still dormant.
  const withBot = [
    ...Array.from({ length: 12 }, (_unused, index) =>
      responded(pr({ number: index + 1, daysAgo: index + 20 }), 0),
    ),
    ...Array.from({ length: 20 }, (_unused, index) => pr({ number: index + 50, daysAgo: index + 20 })),
  ];
  const metrics = computeMetrics(withBot, INPUT);
  assert.equal(metrics.medianHoursResponse, 0, 'the instant median that flagged the problem');
  assert.equal(metrics.responsiveness, 'dormant', 'and the ordinal verdict survived it');
});

test('service accounts holding write access are bots, not fast maintainers', () => {
  /*
   * The maintainer roster promotes anyone with write access, which swept in CI and build accounts
   * that the association check had correctly ignored. mattermost-build answering three PRs at 0h
   * made a repo with only 3 external PRs come out "responsive".
   */
  for (const login of [
    'mattermost-build', 'foo-builder', 'x-deploy', 'y-release', 'ci-jenkins', 'app-runner',
  ]) {
    assert.equal(isBotActor(login), true, login);
  }
});

test('real maintainers observed in the corpus stay human', () => {
  // Every one of these answered PRs in the corpus and must not be swept up by the widened patterns.
  for (const login of [
    'MarkEWaite', 'wy65701436', 'chlins', 'stonezdj', 'Vad1mo', 'timja', 'klembot',
    'buildmaster', 'deployer', 'cam72cam',
  ]) {
    assert.equal(isBotActor(login), false, login);
  }
});
