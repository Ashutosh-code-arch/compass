import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { RUN_KINDS } from './run.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations/', import.meta.url));

/**
 * Guards the failure that motivated this file: 'setup' was added to the RunKind union and not to the
 * sync_runs CHECK constraint, so every setup run died on its first insert with a constraint
 * violation. A type change in one place and a schema change in another are easy to desynchronise.
 */
test('RUN_KINDS matches the latest sync_runs kind constraint', () => {
  const files = readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort();

  let latest: string[] | null = null;
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
    // Later migrations may redefine the constraint; the last one wins.
    for (const match of sql.matchAll(/check\s*\(\s*kind\s+in\s*\(([^)]*)\)/gi)) {
      latest = [...match[1]!.matchAll(/'([^']+)'/g)].map((value) => value[1]!);
    }
  }

  assert.ok(latest, 'no sync_runs kind constraint found in any migration');
  assert.deepEqual(
    [...latest].sort(),
    [...RUN_KINDS].sort(),
    'add a migration redefining sync_runs_kind_check whenever RUN_KINDS changes',
  );
});
