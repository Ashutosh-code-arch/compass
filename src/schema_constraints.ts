/**
 * Reads CHECK constraint values out of the migration files, for the guards that assert a TypeScript
 * union and a SQL constraint still agree.
 *
 * Used only by tests. It lives here rather than inside one of them because three separate guards now
 * need it — `sync_runs.kind`, `org_tags.kind`, and `setup_facts.contributor_agreement` — and the
 * parsing is not obvious enough to want three copies of.
 *
 * Why the guards exist at all: 'setup' was once added to the `RunKind` union and not to the
 * `sync_runs` CHECK constraint, so every setup run died on its first insert. A union in one language
 * and a constraint in another are easy to desynchronise and impossible to notice until a write fails.
 *
 * Why this is table-scoped, which the first version of the guard was not: the original regex searched
 * every migration for `check (kind in (...))` on the assumption that only one table ever had a column
 * called `kind`. Adding `org_tags.kind` broke that assumption immediately, and the failure blamed the
 * new migration for a fault in the guard. A guard that fires on unrelated changes is a guard that
 * gets deleted, so it now has to be told which table it is checking.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url));

/**
 * The allowed values of a column's CHECK constraint, as the latest migration leaves it.
 *
 * Statements are split on semicolons and only those naming the table are considered, so
 * `alter table sync_runs add constraint ... check (kind in (...))` and the original `create table`
 * both match while another table's identically-named column does not. Later migrations win, which is
 * what makes a redefinition in a later file the answer rather than the first definition found.
 *
 * Returns null when no constraint for that column exists in any migration — a distinct outcome from
 * an empty list, and one a caller should assert on rather than silently pass.
 */
export function latestCheckValues(table: string, column: string): string[] | null {
  const files = readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort();
  const pattern = new RegExp(`check\\s*\\(\\s*${column}\\s+in\\s*\\(([^)]*)\\)`, 'gi');

  let latest: string[] | null = null;
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
    for (const statement of sql.split(';')) {
      if (!statement.includes(table)) continue;
      for (const match of statement.matchAll(pattern)) {
        latest = [...match[1]!.matchAll(/'([^']+)'/g)].map((value) => value[1]!);
      }
    }
  }
  return latest;
}
