import assert from 'node:assert/strict';
import { test } from 'node:test';
import { latestCheckValues } from '../schema_constraints.ts';
import { describeWeightSet, isWeightSet, resolveWeights, WEIGHT_SETS } from './weight_sets.ts';
import { WEIGHTS } from './weights.ts';

test('WEIGHT_SETS matches the profile constraint', () => {
  const allowed = latestCheckValues('profile', 'weight_set');
  assert.ok(allowed, 'no profile weight_set constraint found in any migration');
  assert.deepEqual([...allowed].sort(), [...WEIGHT_SETS].sort());
});

/**
 * The property that made the refactor safe to do at all: with no set named, scoring is exactly what it
 * was before named sets existed. Proven separately by diffing CLI output over the dev fixture, but
 * asserted here so a future override cannot quietly leak into the default.
 */
test('the default set is WEIGHTS, unchanged', () => {
  assert.deepEqual(resolveWeights(), WEIGHTS);
  assert.deepEqual(resolveWeights('default'), WEIGHTS);
});

test('career-leverage removes the large-project penalty rather than rewarding size', () => {
  const career = resolveWeights('career-leverage');
  // Zero, not positive. Removing an obstacle is defensible; claiming fame is itself a merit would be
  // inventing a signal.
  assert.equal(career.stars.huge.points, 0);
  assert.equal(WEIGHTS.stars.huge.points, -6);
  assert.ok(career.stars.sweetSpot.points < WEIGHTS.stars.sweetSpot.points);
});

test('career-leverage halves setup cost without removing it', () => {
  const career = resolveWeights('career-leverage');
  assert.ok(career.setupWeight['light']! < WEIGHTS.setupWeight['light']!);
  // Still negative: a heavy setup can end an evening before it starts, and the first contribution is
  // the one most likely to be abandoned.
  assert.ok(career.setupWeight['heavy']! < 0);
});

/**
 * The line the set must not cross. If nobody reads outside pull requests then a famous project is worth
 * less than an obscure one, not more, and no career objective survives a pull request nobody merges.
 */
test('no set touches responsiveness or merge rate', () => {
  for (const name of WEIGHT_SETS) {
    const weights = resolveWeights(name);
    assert.deepEqual(weights.responsiveness, WEIGHTS.responsiveness, name);
    assert.deepEqual(weights.mergeRate, WEIGHTS.mergeRate, name);
    assert.deepEqual(weights.issueMill, WEIGHTS.issueMill, name);
  }
});

test('an override replaces only the keys it names', () => {
  const career = resolveWeights('career-leverage');
  // `moderate` is not mentioned by the override and must survive from the base.
  assert.equal(career.setupWeight['moderate'], WEIGHTS.setupWeight['moderate']);
  assert.equal(career.stars.huge.over, WEIGHTS.stars.huge.over);
});

test('resolving does not mutate the shared constant', () => {
  const before = JSON.stringify(WEIGHTS);
  resolveWeights('career-leverage');
  assert.equal(JSON.stringify(WEIGHTS), before);
});

test('unknown names are not weight sets', () => {
  assert.ok(isWeightSet('career-leverage'));
  assert.ok(!isWeightSet('career'));
  assert.ok(!isWeightSet(''));
});

test('every set can describe itself', () => {
  for (const name of WEIGHT_SETS) assert.ok(describeWeightSet(name).length > 20, name);
});
