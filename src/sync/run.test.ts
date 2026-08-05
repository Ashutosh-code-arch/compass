import assert from 'node:assert/strict';
import { test } from 'node:test';
import { latestCheckValues } from '../schema_constraints.ts';
import { RUN_KINDS } from './run.ts';

/**
 * Guards the failure that motivated this file: 'setup' was added to the RunKind union and not to the
 * sync_runs CHECK constraint, so every setup run died on its first insert with a constraint
 * violation. A type change in one place and a schema change in another are easy to desynchronise.
 *
 * The lookup is scoped to the table. An earlier version searched every migration for
 * `check (kind in (...))` and so started failing the moment a second table acquired a column called
 * `kind` — blaming an unrelated migration for a fault in the guard itself.
 */
test('RUN_KINDS matches the latest sync_runs kind constraint', () => {
  const allowed = latestCheckValues('sync_runs', 'kind');

  assert.ok(allowed, 'no sync_runs kind constraint found in any migration');
  assert.deepEqual(
    [...allowed].sort(),
    [...RUN_KINDS].sort(),
    'add a migration redefining sync_runs_kind_check whenever RUN_KINDS changes',
  );
});
