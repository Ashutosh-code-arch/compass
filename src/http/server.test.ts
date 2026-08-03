import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildServer, shortlistQuery } from './server.ts';
import { VERDICTS } from '../rank/view.ts';

/**
 * These exercise routing, coercion and error mapping only.
 *
 * Every case here either fails validation before the data layer is reached or serves a constant, so
 * none of them opens a connection. Anything that would need Postgres belongs in a test that has one;
 * pretending otherwise with a mocked pool would only assert that the mock behaves like the mock.
 */

// ---------------------------------------------------------------------------
// query coercion
// ---------------------------------------------------------------------------

test('query parameter names match the CLI flags', () => {
  const options = shortlistQuery({
    limit: '10',
    'min-score': '0',
    'per-repo': '3',
    language: 'TypeScript',
    labelled: 'true',
    'include-dormant': '1',
    'max-setup': 'moderate',
    'min-stars': '500',
    'max-stars': '30000',
  });

  assert.deepEqual(options, {
    limit: 10,
    minScore: 0,
    perRepo: 3,
    language: 'TypeScript',
    labelledOnly: true,
    includeDormant: true,
    maxSetupWeight: 'moderate',
    minStars: 500,
    maxStars: 30000,
  });
});

test('an absent parameter is omitted rather than set to undefined', () => {
  // exactOptionalPropertyTypes aside, an explicit undefined would override a default downstream.
  const options = shortlistQuery({});
  assert.deepEqual(Object.keys(options), []);
});

test('a min-score of zero survives coercion', () => {
  // The one threshold that is legitimately zero. Treating it as falsy reinstates the default of 20
  // and silently ignores the request.
  assert.deepEqual(shortlistQuery({ 'min-score': '0' }), { minScore: 0 });
});

test('an explicit false toggle is preserved, not dropped', () => {
  assert.deepEqual(shortlistQuery({ labelled: 'false' }), { labelledOnly: false });
});

test('an empty parameter reads as absent', () => {
  // ?language= is what a cleared UI field sends; it must not filter on the empty string.
  assert.deepEqual(shortlistQuery({ language: '' }), {});
});

test('a non-numeric limit is rejected rather than silently ignored', () => {
  assert.throws(() => shortlistQuery({ limit: 'lots' }), /positive integer/);
  assert.throws(() => shortlistQuery({ limit: '0' }), /positive integer/);
  assert.throws(() => shortlistQuery({ labelled: 'yes' }), /true or false/);
});

test('a repeated parameter is rejected rather than resolved arbitrarily', () => {
  // Fastify parses ?language=a&language=b into an array; picking one silently would be a lie.
  assert.throws(() => shortlistQuery({ language: ['a', 'b'] }), /single value/);
});

// ---------------------------------------------------------------------------
// routing and error mapping
// ---------------------------------------------------------------------------

test('health responds without touching the database', async () => {
  const app = buildServer();
  const response = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true });
  await app.close();
});

test('the verdict vocabulary is served, so the UI does not keep its own copy', async () => {
  const app = buildServer();
  const response = await app.inject({ method: 'GET', url: '/api/verdicts' });
  assert.deepEqual(response.json(), { verdicts: [...VERDICTS] });
  await app.close();
});

test('an unknown route is a 404 with a JSON body', async () => {
  const app = buildServer();
  const response = await app.inject({ method: 'GET', url: '/api/nope' });
  assert.equal(response.statusCode, 404);
  assert.match(response.json().error, /No route for GET/);
  await app.close();
});

test('a non-numeric issue number is a 400, not a database lookup', async () => {
  const app = buildServer();
  const response = await app.inject({ method: 'GET', url: '/api/issues/owner/name/abc/why' });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /numeric/);
  await app.close();
});

test('an unknown verdict is a 400 listing the valid ones', async () => {
  const app = buildServer();
  const response = await app.inject({
    method: 'POST',
    url: '/api/decisions',
    payload: { ref: 'owner/name#1', verdict: 'vibes' },
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /Unknown verdict "vibes"/);
  assert.match(response.json().error, /shortlisted/);
  await app.close();
});

test('a decision without a ref or verdict is a 400', async () => {
  const app = buildServer();
  for (const payload of [{}, { ref: 'owner/name#1' }, { verdict: 'started' }]) {
    const response = await app.inject({ method: 'POST', url: '/api/decisions', payload });
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
    assert.match(response.json().error, /required/);
  }
  await app.close();
});

test('a malformed issue reference is a 400 quoting the expected shape', async () => {
  const app = buildServer();
  const response = await app.inject({
    method: 'POST',
    url: '/api/decisions',
    payload: { ref: 'not-a-ref', verdict: 'started' },
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /owner\/name#123/);
  await app.close();
});

test('non-positive hours are rejected before anything is written', async () => {
  const app = buildServer();
  for (const value of [0, -3, 'four']) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/decisions',
      payload: { ref: 'owner/name#1', verdict: 'started', predictedHours: value },
    });
    assert.equal(response.statusCode, 400, String(value));
    assert.match(response.json().error, /predictedHours must be a positive number/);
  }
  await app.close();
});

test('a bad shortlist parameter is a 400 rather than a 500', async () => {
  const app = buildServer();
  const response = await app.inject({ method: 'GET', url: '/api/shortlist?limit=-1' });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /positive integer/);
  await app.close();
});
