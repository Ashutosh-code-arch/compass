import pg from 'pg';
import { loadConfig } from './config.ts';

// GitHub ids and Postgres bigints both exceed 2^53 in theory but not in practice for repo/issue
// ids. Still, pg returns int8 as string by default; parse to number so callers get one type.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number.parseInt(value, 10));

let pool: pg.Pool | undefined;

export function db(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: loadConfig().databaseUrl, max: 4 });
    pool.on('error', (err) => {
      console.error('[db] idle client error:', err.message);
    });
  }
  return pool;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

export interface BulkUpsertSpec {
  table: string;
  /** Column names, in the same order as each row's values. */
  columns: string[];
  rows: unknown[][];
  /** Columns forming the conflict target, e.g. ['id']. */
  conflictTarget: string[];
  /** Columns to overwrite on conflict. Omit ones that should keep their original value. */
  updateColumns: string[];
  /** Appended verbatim to the ON CONFLICT ... DO UPDATE SET clause, e.g. 'last_synced_at = now()'. */
  extraSet?: string[];
  /** Rows per statement. 20 columns x 200 rows = 4k params, well under Postgres's 65535 cap. */
  chunkSize?: number;
}

/**
 * Multi-row upsert. Returns the number of rows written.
 *
 * `excluded` is the pseudo-table holding the proposed row, so `col = excluded.col` means
 * "take the incoming value".
 */
export async function bulkUpsert(
  client: pg.PoolClient | pg.Pool,
  spec: BulkUpsertSpec,
): Promise<number> {
  const { table, columns, rows, conflictTarget, updateColumns } = spec;
  if (rows.length === 0) return 0;

  const chunkSize = spec.chunkSize ?? 200;
  const setClauses = [
    ...updateColumns.map((c) => `${c} = excluded.${c}`),
    ...(spec.extraSet ?? []),
  ];
  const conflictAction =
    setClauses.length > 0 ? `do update set ${setClauses.join(', ')}` : 'do nothing';

  let written = 0;
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize);
    const params: unknown[] = [];
    const tuples = chunk.map((row) => {
      const placeholders = row.map((value) => {
        params.push(value);
        return `$${params.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });

    const sql =
      `insert into ${table} (${columns.join(', ')}) values ${tuples.join(', ')} ` +
      `on conflict (${conflictTarget.join(', ')}) ${conflictAction}`;

    const result = await client.query(sql, params);
    written += result.rowCount ?? 0;
  }
  return written;
}

/**
 * jsonb columns want a string; pg would otherwise try to infer and can guess wrong.
 *
 * NUL needs removing because Postgres jsonb rejects the \u0000 escape that JSON.stringify emits for
 * it. It has to happen in a REPLACER, on the values, not with a regex over the serialised output: a
 * body legitimately containing the six characters \u0000 (someone discussing NUL in a code block)
 * serialises to \\u0000, and stripping the tail of that leaves a dangling backslash and therefore
 * invalid JSON — `invalid input syntax for type json`.
 */
export function jsonb(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === 'string' ? entry.replace(/\u0000/g, '') : entry,
  );
}

/**
 * Postgres text columns cannot store NUL, and a single one anywhere in a batch fails the entire
 * statement: `invalid byte sequence for encoding "UTF8": 0x00`.
 */
export function stripNul<T extends string | null | undefined>(value: T): T {
  return (typeof value === 'string' ? value.replace(/\u0000/g, '') : value) as T;
}
