import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('./', import.meta.url));

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      found.push(path);
    }
  }
  return found;
}

/**
 * Postgres infers a bind parameter's type from its context. When BOTH operands of an operator are
 * untyped — two parameters, or a parameter and a bare string literal — there is nothing to infer
 * from, and the statement either fails outright or resolves to a type that contradicts the same
 * parameter's use elsewhere.
 *
 * Two real failures from this exact pattern:
 *
 *   sync_error_count = $3, ... case when $3 >= $4 then ...
 *     -> "inconsistent types deduced for parameter $3": integer from the assignment, text from the
 *        comparison. Killed a 200-repo issue sync.
 *
 *   now() - ($1 || ' hours')::interval
 *     -> parameter and string literal both untyped.
 *
 * An explicit cast on either side fixes it. Comparing a parameter against a real column is fine,
 * because the column supplies the type — so only parameter-versus-parameter and
 * parameter-versus-literal are flagged.
 */
test('no SQL compares two untyped parameters', () => {
  const offenders: string[] = [];
  // $3 >= $4, $1 || $2, and the reverse ordering, with no :: cast on either side.
  const paramVsParam = /\$\d+(?!::)\s*(?:>=|<=|<>|!=|=|>|<|\|\|)\s*\$\d+(?!::)/g;

  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(paramVsParam)) {
      offenders.push(`${file.replace(SRC, '')}: ${match[0]}`);
    }
  }

  assert.deepEqual(offenders, [], 'cast one side, e.g. $3::int >= $4::int');
});

test('no SQL concatenates an untyped parameter with a bare string literal', () => {
  const offenders: string[] = [];
  // $1 || ' hours'  or  'prefix ' || $1
  const paramVsLiteral =
    /\$\d+(?!::)\s*\|\|\s*'[^']*'|'[^']*'\s*\|\|\s*\$\d+(?!::)/g;

  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(paramVsLiteral)) {
      offenders.push(`${file.replace(SRC, '')}: ${match[0]}`);
    }
  }

  assert.deepEqual(offenders, [], 'cast the parameter, or use make_interval / format instead');
});
