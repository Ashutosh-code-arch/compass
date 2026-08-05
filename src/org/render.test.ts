import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatYears } from './render.ts';

test('contiguous years collapse to a range', () => {
  assert.equal(formatYears([2024, 2025, 2026]), '2024\u201326');
  assert.equal(formatYears([2026]), '2026');
  assert.equal(formatYears([]), '');
});

test('gaps are preserved rather than smoothed over', () => {
  // A project that participated in 2019 and again in 2026 is not one that participated throughout,
  // and the difference is the whole reason the years are stored per value.
  assert.equal(formatYears([2019, 2025, 2026]), '2019, 2025\u201326');
});
