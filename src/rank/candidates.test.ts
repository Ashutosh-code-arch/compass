import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CANDIDATE_GATES } from './candidates.ts';

/**
 * The organisation table reports how many open candidates each organisation has, and the shortlist
 * decides what a candidate IS. If those two ever come from separate copies of the same conditions,
 * the org screen quietly disagrees with the shortlist it links to — a row promising six candidates
 * that opens onto four, with nothing anywhere saying why.
 *
 * This asserts both queries interpolate the shared fragment rather than restating it.
 */
test('the shortlist and the org rollup share one definition of a candidate', () => {
  const read = (path: string): string =>
    readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

  for (const path of ['./candidates.ts', '../org/data.ts']) {
    assert.match(
      read(path),
      /\$\{CANDIDATE_GATES\}/,
      `${path} must interpolate CANDIDATE_GATES, not restate the gates`,
    );
  }
});

/**
 * The gates that are unconditional, and the one that deliberately is not.
 *
 * `responsiveness <> 'dormant'` belongs to the shortlist alone: the org table's most valuable row is
 * "this GSoC organisation has 40 open issues and has not replied to an outsider in 31 days", and a
 * shared dormant filter would hide exactly that.
 */
test('the shared fragment covers the unconditional gates only', () => {
  for (const gate of ['state = \'open\'', 'assignee_logins', 'is_locked', 'sync_state', 'decisions']) {
    assert.match(CANDIDATE_GATES, new RegExp(gate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(CANDIDATE_GATES, /dormant/);
  // No bind parameters: the fragment is interpolated into queries that number their own.
  assert.doesNotMatch(CANDIDATE_GATES, /\$\d/);
});
