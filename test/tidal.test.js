import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '../src/database.js';
import { TidalClient } from '../src/tidal.js';

function saveTokens(database) {
  database.saveTokens({
    userId: 'user', accessToken: 'access', refreshToken: 'refresh', tokenType: 'Bearer',
    scopes: [], expiresAt: '2099-01-01T00:00:00.000Z', updatedAt: new Date().toISOString(),
  });
}

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

test('concurrent TIDAL reads are FIFO, non-overlapping, and spaced from actual starts', async () => {
  const database = new Database(':memory:');
  saveTokens(database);
  let now = 1_000;
  let inFlight = 0;
  let maxInFlight = 0;
  let releaseFirst;
  const starts = [];
  const client = new TidalClient(database, {
    now: () => now,
    sleepImpl: async (ms) => { now += ms; },
    fetchImpl: async () => {
      starts.push(now);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (starts.length === 1) await new Promise((resolve) => { releaseFirst = resolve; });
      inFlight -= 1;
      return Response.json({ data: { id: String(starts.length) } });
    },
  });

  const first = client.currentUser();
  const second = client.currentUser();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, [1_000]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(starts, [1_000, 1_500]);
  assert.equal(maxInFlight, 1);
  database.close();
});

test('a final TIDAL rate limit blocks an already queued caller before fetch', async () => {
  const database = new Database(':memory:');
  saveTokens(database);
  let calls = 0;
  const client = new TidalClient(database, {
    requestIntervalMs: 0,
    fetchImpl: async () => {
      calls += 1;
      return new Response('{}', { status: 429, headers: { 'Retry-After': '30' } });
    },
  });

  const results = await Promise.allSettled([client.currentUser(), client.currentUser()]);
  assert.equal(calls, 1);
  assert.deepEqual(results.map((result) => result.reason.service), ['tidal', 'tidal']);
  assert.deepEqual(results.map((result) => result.reason.status), [429, 429]);
  database.close();
});

test('every retry re-enters the TIDAL gate and delayed timers cannot compress starts', async () => {
  const database = new Database(':memory:');
  saveTokens(database);
  let now = 1_000;
  const starts = [];
  const client = new TidalClient(database, {
    now: () => now,
    sleepImpl: async (ms) => { now += ms + 300; },
    fetchImpl: async () => {
      starts.push(now);
      return starts.length < 3 ? new Response('{}', { status: 500 }) : Response.json({ data: { id: 'user' } });
    },
  });

  await client.currentUser();
  assert.equal(starts.length, 3);
  assert.ok(starts.every((start, index) => index === 0 || start - starts[index - 1] >= 500));
  database.close();
});

test('a network exception releases the TIDAL gate for a queued caller', async () => {
  const database = new Database(':memory:');
  saveTokens(database);
  let calls = 0;
  const client = new TidalClient(database, {
    requestIntervalMs: 0,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new Error('connection reset');
      return Response.json({ data: { id: 'user' } });
    },
  });

  const mutation = client.addPlaylistItems('playlist', [{ trackId: 'track' }], 'key');
  const read = client.currentUser();
  await assert.rejects(mutation, (error) => error.code === 'NETWORK_ERROR' && error.service === 'tidal' && error.unsafeWrite);
  assert.equal((await read).id, 'user');
  assert.equal(calls, 2);
  database.close();
});

test('malformed responses and invalid pagination links retain TIDAL attribution', async () => {
  const database = new Database(':memory:');
  saveTokens(database);
  const malformed = new TidalClient(database, { requestIntervalMs: 0, fetchImpl: async () => new Response('not json') });
  await assert.rejects(malformed.currentUser(), (error) => error.code === 'TIDAL_INVALID_RESPONSE' && error.service === 'tidal');

  const invalidLink = new TidalClient(database, {
    requestIntervalMs: 0,
    fetchImpl: async () => Response.json({ data: [], links: { next: 'https://evil.example/playlists' } }),
  });
  await assert.rejects(invalidLink.allOwnedPlaylists(), (error) => error.code === 'TIDAL_INVALID_LINK' && error.service === 'tidal');
  database.close();
});

test('TIDAL request timeouts release the gate and retain attribution', async () => {
  const database = new Database(':memory:');
  saveTokens(database);
  let calls = 0;
  const client = new TidalClient(database, {
    requestIntervalMs: 0,
    requestTimeoutMs: 1,
    sleepImpl: async () => {},
    fetchImpl: async (url, options) => {
      calls += 1;
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }));
    },
  });

  await assert.rejects(client.currentUser(), (error) =>
    error.code === 'NETWORK_ERROR' && error.message.includes('timed out') && error.service === 'tidal');
  assert.equal(calls, 3);
  database.close();
});
