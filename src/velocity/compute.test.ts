import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assessMomentum,
  computeVelocity,
  describeMomentum,
  DROWNING_OPEN_PRS,
  MIN_SPAN_DAYS,
  SURGE_MULTIPLE,
  SURGE_PER_DAY,
  YOUNG_DAYS,
  type StarSample,
  type Velocity,
} from './compute.ts';

const NOW = new Date('2026-08-04T00:00:00Z');
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const sample = (days: number, stars: number): StarSample => ({ observedAt: daysAgo(days), stars });

const velocityOf = (samples: StarSample[], windowDays = 90) =>
  computeVelocity(samples, { now: NOW, windowDays });

// ------------------------------------------------------------------ velocity

test('velocity is the difference between the oldest and newest sample in the window', () => {
  const velocity = velocityOf([sample(60, 1000), sample(30, 1600), sample(0, 2200)]);
  assert.ok(velocity);
  assert.equal(velocity.gained, 1200);
  assert.equal(velocity.spanDays, 60);
  assert.equal(velocity.perDay, 20);
  assert.equal(velocity.baseline, 1000);
  assert.equal(velocity.latest, 2200);
  assert.equal(velocity.samples, 3);
});

test('the multiple describes growth relative to where it started', () => {
  const velocity = velocityOf([sample(30, 400), sample(0, 1200)]);
  assert.equal(velocity?.multiple, 3);
});

/**
 * A baseline of zero would make the multiple infinite. Reporting a large number instead would look like
 * a measurement rather than a division by nothing.
 */
test('a zero baseline yields a null multiple, not an enormous one', () => {
  const velocity = velocityOf([sample(30, 0), sample(0, 5000)]);
  assert.equal(velocity?.multiple, null);
  // The absolute figure is still perfectly good.
  assert.equal(velocity?.gained, 5000);
});

test('one sample cannot produce a velocity', () => {
  assert.equal(velocityOf([sample(10, 500)]), null);
  assert.equal(velocityOf([]), null);
});

/**
 * The rule that keeps this honest. Two samples a day apart differ by whatever was trending that day,
 * and dividing by a span of one gives a per-day rate less precise than the answer it states.
 */
test('a span shorter than a week is unmeasured, not slow', () => {
  assert.equal(MIN_SPAN_DAYS, 7);
  assert.equal(velocityOf([sample(3, 1000), sample(0, 1400)]), null);
  assert.ok(velocityOf([sample(8, 1000), sample(0, 1400)]));
});

test('samples outside the window are excluded, and the span reflects what was used', () => {
  const velocity = velocityOf([sample(400, 10), sample(60, 1000), sample(0, 1600)], 90);
  // Not 400 days: the span is what the samples in the window actually cover.
  assert.equal(velocity?.spanDays, 60);
  assert.equal(velocity?.baseline, 1000);
});

test('losing stars is reported as a loss rather than clamped to zero', () => {
  const velocity = velocityOf([sample(30, 5000), sample(0, 4800)]);
  assert.equal(velocity?.gained, -200);
  assert.ok(velocity!.perDay < 0);
});

// ------------------------------------------------------------------ momentum

const flat: Velocity = {
  gained: 300, spanDays: 60, perDay: 5, multiple: 1.03, baseline: 10000, latest: 10300, samples: 3,
};
const surge: Velocity = {
  gained: 30000, spanDays: 60, perDay: 500, multiple: 4, baseline: 10000, latest: 40000, samples: 3,
};

const assess = (overrides: Partial<Parameters<typeof assessMomentum>[0]> = {}) =>
  assessMomentum({
    velocity: flat,
    ageDays: 2000,
    responsiveness: 'responsive',
    mergeRate: 0.8,
    decidedPrs: 40,
    openPrTotal: 12,
    ...overrides,
  });

test('unmeasured velocity gives a null verdict, not steady', () => {
  const finding = assess({ velocity: null });
  assert.equal(finding.verdict, null);
  // A project whose growth has not been measured is not a project that is not growing.
  assert.equal(finding.surging, false);
});

test('normal growth with healthy review is steady', () => {
  assert.equal(assess().verdict, 'steady');
});

/**
 * The combination the whole file exists for. Every star-ranked discovery list puts this project at the
 * top; it is the worst place to spend five hours.
 */
test('surging growth with no review capacity is hype', () => {
  const finding = assess({ velocity: surge, responsiveness: 'dormant', ageDays: 200 });
  assert.equal(finding.verdict, 'hype');
  assert.equal(finding.surging, true);
  assert.equal(finding.young, true);
  assert.match(finding.capacityConcern!, /nobody answers/);
});

/**
 * The other half, and the reason `hype` is never reached from growth alone. "This project is popular"
 * is not a criticism, and a verdict that amounted to one would be taste dressed as measurement.
 */
test('surging growth WITH review capacity is rising, not hype', () => {
  const finding = assess({ velocity: surge, ageDays: 120 });
  assert.equal(finding.verdict, 'rising');
  assert.equal(finding.capacityConcern, null);
  // Young and surging is not enough on its own.
  assert.equal(finding.young, true);
});

test('either surge test is sufficient', () => {
  assert.equal(SURGE_PER_DAY, 50);
  assert.equal(SURGE_MULTIPLE, 1.5);

  // Fast in absolute terms, barely moved relative to a huge base.
  const bigAndFast = assess({
    velocity: { ...flat, perDay: 60, multiple: 1.05 },
    responsiveness: 'slow',
  });
  assert.equal(bigAndFast.verdict, 'hype');

  // Small project tripling: slow in absolute terms, the same phenomenon at a different scale.
  const smallAndTripling = assess({
    velocity: { ...flat, perDay: 8, multiple: 3, baseline: 200, latest: 600 },
    responsiveness: 'slow',
  });
  assert.equal(smallAndTripling.verdict, 'hype');
});

test('a drowning queue is a capacity concern even when replies are fast', () => {
  const finding = assess({
    velocity: surge,
    responsiveness: 'responsive',
    openPrTotal: DROWNING_OPEN_PRS,
  });
  assert.equal(finding.verdict, 'hype');
  assert.match(finding.capacityConcern!, /open pull requests waiting/);
});

test('a low merge rate needs a denominator before it counts', () => {
  // One of two merged is not evidence about anything.
  const thin = assess({ velocity: surge, mergeRate: 0.5, decidedPrs: 2 });
  assert.equal(thin.verdict, 'rising');

  const real = assess({ velocity: surge, mergeRate: 0.2, decidedPrs: 40 });
  assert.equal(real.verdict, 'hype');
  assert.match(real.capacityConcern!, /20%/);
});

test('losing stars is cooling regardless of capacity', () => {
  const finding = assess({ velocity: { ...flat, gained: -400, perDay: -6, multiple: 0.96 } });
  assert.equal(finding.verdict, 'cooling');
  assert.equal(finding.surging, false);
});

test('youth is reported separately so a mature project can also drown', () => {
  assert.equal(YOUNG_DAYS, 730);
  const mature = assess({ velocity: surge, ageDays: 4000, responsiveness: 'dormant' });
  assert.equal(mature.verdict, 'hype');
  assert.equal(mature.young, false);
});

test('unknown age does not make a project young', () => {
  assert.equal(assess({ ageDays: null }).young, false);
});

// ------------------------------------------------------------------ wording

test('the description always carries the numbers behind the verdict', () => {
  const finding = assess({ velocity: surge, responsiveness: 'dormant', ageDays: 100 });
  const line = describeMomentum(finding, surge);
  assert.match(line!, /^hype/);
  assert.match(line!, /\+500\/day/);
  assert.match(line!, /young/);
  assert.match(line!, /nobody answers/);
});

test('a slow-moving project is described by its total rather than a rate below one', () => {
  const slow: Velocity = {
    gained: 12, spanDays: 60, perDay: 0.2, multiple: 1.1, baseline: 120, latest: 132, samples: 2,
  };
  assert.match(describeMomentum(assess({ velocity: slow }), slow)!, /\+12 in 60d/);
});

test('nothing is described when nothing was measured', () => {
  assert.equal(describeMomentum(assess({ velocity: null }), null), null);
});
