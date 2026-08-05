import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bucketToUtcDay } from './stars.ts';

/**
 * The bucket is the only judgement in the star history writer, and it decides what a sample means.
 * An instant-resolution table would let sync frequency masquerade as sampling quality: someone
 * running `sync repos` hourly would accumulate 24 rows a day per repository, and a window query over
 * their corpus would behave differently from the same query over a corpus synced once a day, for
 * reasons that have nothing to do with the projects being measured.
 */
test('every moment in a UTC day buckets to the same midnight', () => {
  const midnight = bucketToUtcDay(new Date('2026-08-04T00:00:00.000Z'));
  assert.equal(midnight, '2026-08-04T00:00:00.000Z');
  assert.equal(bucketToUtcDay(new Date('2026-08-04T13:47:12.881Z')), midnight);
  assert.equal(bucketToUtcDay(new Date('2026-08-04T23:59:59.999Z')), midnight);
});

test('the next day is a different bucket', () => {
  assert.notEqual(
    bucketToUtcDay(new Date('2026-08-04T23:59:59.999Z')),
    bucketToUtcDay(new Date('2026-08-05T00:00:00.000Z')),
  );
});

/**
 * UTC rather than local time, so which bucket a sample lands in does not depend on where the machine
 * is or on it moving. A laptop crossing a timezone must not appear to sample twice on one day and not
 * at all on the next.
 */
test('the bucket is UTC, not local', () => {
  // 21:30 on the 4th in UTC is already the 5th in Asia/Kolkata, and the bucket must ignore that.
  assert.equal(bucketToUtcDay(new Date('2026-08-04T21:30:00.000Z')), '2026-08-04T00:00:00.000Z');
});
