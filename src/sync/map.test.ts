import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jsonb, stripNul } from '../db.ts';
import { ISSUE_COLUMNS, mapIssueRow } from './map.ts';
import type { GhIssue } from '../github/types.ts';

const NUL = '\u0000';

function issue(overrides: Partial<GhIssue> = {}): GhIssue {
  return {
    id: 1,
    node_id: 'I_1',
    number: 1,
    title: 'title',
    body: 'body',
    state: 'open',
    labels: [],
    user: { login: 'someone', id: 2 },
    comments: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    closed_at: null,
    html_url: 'https://example.invalid/1',
    ...overrides,
  };
}

/*
 * A single NUL byte in one issue body failed an entire batch insert with
 * `invalid byte sequence for encoding "UTF8": 0x00`, losing every issue in that repo. Postgres
 * rejects NUL in text columns, and rejects the \u0000 escape that JSON.stringify emits for it in
 * jsonb — so both paths need handling.
 */
test('NUL is stripped from text values', () => {
  assert.equal(stripNul(`a${NUL}b`), 'ab');
  assert.equal(stripNul(null), null);
  assert.equal(stripNul(undefined), undefined);
  assert.equal(stripNul('clean'), 'clean');
});

test('jsonb output never contains the escape Postgres rejects', () => {
  const encoded = jsonb({ body: `a${NUL}b`, nested: { title: `x${NUL}` } });
  assert.ok(!encoded.includes('\\u0000'), encoded);
  assert.deepEqual(JSON.parse(encoded), { body: 'ab', nested: { title: 'x' } });
});

test('a mapped issue row carries no NUL in any field', () => {
  const row = mapIssueRow(
    issue({ title: `Crash on ${NUL} input`, body: `Steps:${NUL}\n1. run` }),
    42,
  );
  const title = row[ISSUE_COLUMNS.indexOf('title')] as string;
  const body = row[ISSUE_COLUMNS.indexOf('body')] as string;
  const raw = row[ISSUE_COLUMNS.indexOf('raw')] as string;

  assert.equal(title, 'Crash on  input');
  assert.ok(!body.includes(NUL));
  assert.ok(!raw.includes('\\u0000'), 'the raw payload must be jsonb-safe too');
  // Content must otherwise survive intact.
  assert.match(body, /Steps:/);
  assert.match(body, /1\. run/);
});

test('a null body still maps to null rather than an empty string', () => {
  const row = mapIssueRow(issue({ body: null }), 42);
  assert.equal(row[ISSUE_COLUMNS.indexOf('body')], null);
});
