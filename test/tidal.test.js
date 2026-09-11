import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '../src/database.js';
import { TidalClient } from '../src/tidal.js';

test('authorization callback validates PKCE state, scopes, and authenticated user', async () => {
  const database = new Database(':memory:');
  database.saveCredentials('client-id', 'client-secret');
  let tokenForm;
  const client = new TidalClient(database, {
    fetchImpl: async (url, options) => {
      if (String(url).includes('/oauth2/token')) {
        tokenForm = Object.fromEntries(options.body);
        return Response.json({
          access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer', expires_in: 3600,
          scope: 'user.read playlists.read playlists.write search.read',
        });
      }
      if (String(url).endsWith('/users/me')) return Response.json({ data: { type: 'users', id: 'user-1' } });
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  const authorization = new URL(client.authorizationUrl());
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(authorization.searchParams.get('code_challenge'));
  await client.completeAuthorization({ state: authorization.searchParams.get('state'), code: 'authorization-code' });
  assert.equal(tokenForm.grant_type, 'authorization_code');
  assert.equal(tokenForm.code, 'authorization-code');
  assert.ok(tokenForm.code_verifier);
  assert.equal(database.tokens().user_id, 'user-1');
  await assert.rejects(client.completeAuthorization({ state: authorization.searchParams.get('state'), code: 'replay' }), { code: 'TIDAL_AUTH_STATE' });
  database.close();
});

test('a malformed mutation response is classified as an unsafe write', async () => {
  const database = new Database(':memory:');
  database.saveTokens({
    userId: 'user', accessToken: 'access', refreshToken: 'refresh', tokenType: 'Bearer',
    scopes: ['user.read', 'playlists.read', 'playlists.write', 'search.read'],
    expiresAt: '2099-01-01T00:00:00.000Z', updatedAt: new Date().toISOString(),
  });
  const client = new TidalClient(database, {
    fetchImpl: async () => new Response('not json', { status: 200, headers: { 'Content-Type': 'application/vnd.api+json' } }),
  });
  await assert.rejects(client.addPlaylistItems('playlist', [{ trackId: 'track' }], 'key'), (error) => {
    assert.equal(error.code, 'TIDAL_INVALID_RESPONSE');
    assert.equal(error.unsafeWrite, true);
    return true;
  });
  database.close();
});

test('an empty mutation response is classified as an unsafe write', async () => {
  const database = new Database(':memory:');
  database.saveTokens({
    userId: 'user', accessToken: 'access', refreshToken: 'refresh', tokenType: 'Bearer',
    scopes: ['user.read', 'playlists.read', 'playlists.write', 'search.read'],
    expiresAt: '2099-01-01T00:00:00.000Z', updatedAt: new Date().toISOString(),
  });
  const client = new TidalClient(database, { fetchImpl: async () => new Response(null, { status: 200 }) });
  await assert.rejects(client.addPlaylistItems('playlist', [{ trackId: 'track' }], 'key'), (error) => {
    assert.equal(error.code, 'TIDAL_INVALID_RESPONSE');
    assert.equal(error.unsafeWrite, true);
    return true;
  });
  database.close();
});

test('TIDAL API requests are paced before reaching the network', async () => {
  const database = new Database(':memory:');
  database.saveTokens({
    userId: 'user', accessToken: 'access', refreshToken: 'refresh', tokenType: 'Bearer',
    scopes: [], expiresAt: '2099-01-01T00:00:00.000Z', updatedAt: new Date().toISOString(),
  });
  let now = 1_000;
  const requestTimes = [];
  const client = new TidalClient(database, {
    now: () => now,
    sleepImpl: async (ms) => { now += ms; },
    fetchImpl: async () => {
      requestTimes.push(now);
      return Response.json({ data: { type: 'users', id: 'user' } });
    },
  });

  await client.currentUser();
  await client.currentUser();

  assert.deepEqual(requestTimes, [1_000, 1_500]);
  database.close();
});

test('a long Retry-After returns the 429 without retrying early', async () => {
  const database = new Database(':memory:');
  database.saveTokens({
    userId: 'user', accessToken: 'access', refreshToken: 'refresh', tokenType: 'Bearer',
    scopes: [], expiresAt: '2099-01-01T00:00:00.000Z', updatedAt: new Date().toISOString(),
  });
  let calls = 0;
  const client = new TidalClient(database, {
    requestIntervalMs: 0,
    sleepImpl: async () => {},
    fetchImpl: async () => {
      calls += 1;
      return new Response('rate limited', { status: 429, headers: { 'Retry-After': '30' } });
    },
  });

  await assert.rejects(client.currentUser(), (error) => {
    assert.equal(error.status, 429);
    assert.equal(error.retryable, true);
    return true;
  });
  await assert.rejects(client.currentUser(), { code: 'TIDAL_RATE_LIMITED', status: 429 });
  assert.equal(calls, 1);
  database.close();
});

test('a rate-limited mutation gets exactly one network attempt', async () => {
  const database = new Database(':memory:');
  database.saveTokens({
    userId: 'user', accessToken: 'access', refreshToken: 'refresh', tokenType: 'Bearer',
    scopes: [], expiresAt: '2099-01-01T00:00:00.000Z', updatedAt: new Date().toISOString(),
  });
  let calls = 0;
  const client = new TidalClient(database, {
    requestIntervalMs: 0,
    fetchImpl: async () => {
      calls += 1;
      return Response.json({ errors: [{ detail: 'Slow down.' }] }, { status: 429 });
    },
  });

  await assert.rejects(client.addPlaylistItems('playlist', [{ trackId: 'track' }], 'key'), (error) => {
    assert.equal(error.status, 429);
    assert.equal(error.unsafeWrite, true);
    return true;
  });
  assert.equal(calls, 1);
  database.close();
});
