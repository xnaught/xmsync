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
