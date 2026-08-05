import assert from 'node:assert/strict';
import { test } from 'node:test';
import { latestCheckValues } from '../schema_constraints.ts';
import { isOrgTagKind, ORG_TAG_KINDS } from './orgs.ts';

/**
 * Same guard as RUN_KINDS, for the same reason: a union in TypeScript and a CHECK constraint in SQL
 * that only meet at insert time. Phase 1 writes GSoC years through this vocabulary, and the failure
 * mode is an ingestion run that dies partway with a constraint violation after spending its requests.
 */
test('ORG_TAG_KINDS matches the org_tags kind constraint', () => {
  const allowed = latestCheckValues('org_tags', 'kind');

  assert.ok(allowed, 'no org_tags kind constraint found in any migration');
  assert.deepEqual(
    [...allowed].sort(),
    [...ORG_TAG_KINDS].sort(),
    'add a migration redefining the org_tags kind constraint whenever ORG_TAG_KINDS changes',
  );
});

test('isOrgTagKind rejects anything not in the vocabulary', () => {
  assert.ok(isOrgTagKind('gsoc_year'));
  assert.ok(!isOrgTagKind('gsoc_years'));
  assert.ok(!isOrgTagKind(''));
});
