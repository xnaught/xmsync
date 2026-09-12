import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '../src/database.js';
import { AppError } from '../src/errors.js';
import { RunCoordinator } from '../src/scheduler.js';
import { SyncEngine } from '../src/sync-engine.js';
import { TidalClient } from '../src/tidal.js';
import { XmPlaylistClient } from '../src/xmplaylist.js';

const channel = { id: 'station-1', deeplink: 'test', name: 'Test Radio', number: '42' };

function rawPlay(id, timestamp) {
  return {
    id,
    timestamp,
    track: { id: 'xm-track', title: 'Dreams', artists: ['Fleetwood Mac'] },
    links: [{ site: 'tidal', url: 'http://www.tidal.com/track/tidal-track' }],
  };
}

function makeTidal() {
  return {
    creates: 0,
    writes: [],
    playlistContents: [],
    async validateTrack(id) { return id; },
    async searchTrack() { throw new Error('search should not be needed'); },
    async allOwnedPlaylists() { return []; },
    async createPlaylist() { this.creates += 1; return { data: { id: 'playlist-1' } }; },
    async addPlaylistItems(id, items) {
      this.writes.push({ id, items });
      const added = items.map((item, index) => ({ type: 'tracks', id: item.trackId, meta: { itemId: `occurrence-${this.playlistContents.length + index}` } }));
      this.playlistContents.push(...added);
      return { data: added };
    },
    async playlistItems() { return this.playlistContents; },
  };
}

async function waitForIdle(coordinator) {
  while (coordinator.active) await new Promise((resolve) => setImmediate(resolve));
}

test('distinct repeated airplays append as distinct ordered playlist occurrences and do not duplicate on retry', async () => {
  const database = new Database(':memory:');
  database.saveTokens({
    userId: 'user', accessToken: 'a', refreshToken: 'r', tokenType: 'Bearer', scopes: [],
    expiresAt: '2099-01-01T00:00:00.000Z', updatedAt: '2026-09-11T00:00:00.000Z',
  });
  const xm = { async page() {
    return { results: [rawPlay('newer', '2026-09-11T12:10:00.000Z'), rawPlay('older', '2026-09-11T12:00:00.000Z')], next: null };
  } };
  const tidal = makeTidal();
  const engine = new SyncEngine(database, xm, tidal, { clock: () => new Date('2026-09-11T13:00:00.000Z') });

  const first = await engine.run('manual', channel);
  assert.equal(first.status, 'completed');
  assert.equal(first.counts.synced, 2);
  assert.equal(tidal.creates, 1);
  assert.deepEqual(tidal.writes[0].items, [{ trackId: 'tidal-track' }, { trackId: 'tidal-track' }]);
  const rows = database.db.prepare('SELECT play_id, status, occurrence_id FROM plays ORDER BY airplay_at').all();
  assert.deepEqual(rows.map((row) => row.play_id), ['older', 'newer']);
  assert.deepEqual(rows.map((row) => row.occurrence_id), ['occurrence-0', 'occurrence-1']);

  const second = await engine.run('manual', channel);
  assert.equal(second.counts.alreadyProcessed, 2);
  assert.equal(second.counts.synced, 0);
  assert.equal(tidal.writes.length, 1);
  database.close();
});

test('a date with no catalog match does not create a playlist', async () => {
  const database = new Database(':memory:');
  const xm = { async page() { return { results: [{
    id: 'play', timestamp: '2026-09-11T12:00:00.000Z', track: { id: 'track', title: 'Missing', artists: ['Nobody'] }, links: [],
  }], next: null }; } };
  const tidal = makeTidal();
  tidal.searchTrack = async () => null;
  const engine = new SyncEngine(database, xm, tidal, { clock: () => new Date('2026-09-11T13:00:00.000Z') });
  const result = await engine.run('manual', channel);
  assert.equal(result.counts.skipped, 1);
  assert.equal(tidal.creates, 0);
  assert.equal(database.db.prepare('SELECT status FROM plays').get().status, 'skipped');
  database.close();
});

test('failed pagination leaves the contiguous watermark unchanged', async () => {
  const database = new Database(':memory:');
  let calls = 0;
  const xm = { async page() {
    calls += 1;
    if (calls === 2) throw new AppError('XM_REQUEST_FAILED', 'page failed', { service: 'xmplaylist' });
    return {
      results: [rawPlay('play', '2026-09-11T12:00:00.000Z')],
      next: 'http://xmplaylist.com/api/station/test?last=1789128000000',
    };
  } };
  const tidal = makeTidal();
  const engine = new SyncEngine(database, xm, tidal, { clock: () => new Date('2026-09-11T13:00:00.000Z') });
  const result = await engine.run('schedule', channel);
  assert.equal(result.status, 'partial');
  assert.equal(database.getScanState(channel.id), undefined);
  assert.equal(result.counts.synced, 1);
  database.close();
});

test('an exhausted TIDAL rate limit stops resolution of later historical plays', async () => {
  const database = new Database(':memory:');
  const xm = { async page() {
    return {
      results: [rawPlay('newer', '2026-09-11T12:10:00.000Z'), rawPlay('older', '2026-09-11T12:00:00.000Z')],
      next: null,
    };
  } };
  const tidal = makeTidal();
  let calls = 0;
  tidal.validateTrack = async () => {
    calls += 1;
    throw new AppError('TIDAL_REQUEST_FAILED', 'TIDAL returned HTTP 429.', { status: 429, retryable: true, service: 'tidal' });
  };
  const engine = new SyncEngine(database, xm, tidal, { clock: () => new Date('2026-09-11T13:00:00.000Z') });

  const result = await engine.run('manual', channel);

  assert.equal(result.status, 'failed');
  assert.equal(result.error.status, 429);
  assert.equal(calls, 1);
  assert.equal(tidal.creates, 0);
  assert.deepEqual(database.db.prepare('SELECT status FROM plays ORDER BY airplay_at').all().map((row) => row.status), ['failed', 'pending']);
  database.close();
});

test('two channels independently sync the same raw play ID using stable playlist labels', async () => {
  const database = new Database(':memory:');
  database.saveTokens({
    userId: 'user', accessToken: 'a', refreshToken: 'r', tokenType: 'Bearer', scopes: [],
    expiresAt: '2099-01-01T00:00:00.000Z', updatedAt: '2026-09-11T00:00:00.000Z',
  });
  const xm = { async page() { return { results: [rawPlay('shared', '2026-09-11T12:00:00.000Z')], next: null }; } };
  const tidal = makeTidal();
  tidal.createPlaylist = async (name) => ({ data: { id: name.includes('Ch. 1') ? 'playlist-1' : 'playlist-2' } });
  const engine = new SyncEngine(database, xm, tidal, { clock: () => new Date('2026-09-11T13:00:00.000Z') });
  const first = { id: 'one', deeplink: 'one', name: 'Blend', number: '1', playlistLabel: 'Blend (Ch. 1)' };
  const second = { id: 'two', deeplink: 'two', name: 'Blend', number: '2', playlistLabel: 'Blend (Ch. 2)' };
  assert.equal((await engine.run('manual', first)).counts.synced, 1);
  assert.equal((await engine.run('manual', second)).counts.synced, 1);
  assert.equal(database.db.prepare("SELECT count(*) count FROM plays WHERE play_id='shared' AND status='synced'").get().count, 2);
  assert.deepEqual(database.db.prepare('SELECT expected_name FROM playlists ORDER BY channel_id').all().map((row) => row.expected_name), [
    'Blend (Ch. 1) - 2026-09-11', 'Blend (Ch. 2) - 2026-09-11',
  ]);
  database.close();
});

test('a scan failure is retained while a later TIDAL account failure becomes the run error', async () => {
  const database = new Database(':memory:');
  let pages = 0;
  const xm = { async page() {
    pages += 1;
    if (pages === 2) throw new AppError('XM_REQUEST_FAILED', 'scan limited', { status: 429, service: 'xmplaylist' });
    return {
      results: [rawPlay('play', '2026-09-11T12:00:00.000Z')],
      next: 'https://xmplaylist.com/api/station/test?last=1',
    };
  } };
  const tidal = makeTidal();
  tidal.validateTrack = async () => {
    throw new AppError('TIDAL_REQUEST_FAILED', 'account limited', { status: 429, retryable: true, service: 'tidal' });
  };
  const engine = new SyncEngine(database, xm, tidal, { clock: () => new Date('2026-09-11T13:00:00.000Z') });

  const result = await engine.run('manual', channel);

  assert.equal(result.error.code, 'TIDAL_REQUEST_FAILED');
  assert.deepEqual(database.runItems(result.id).map((item) => item.error_code), ['XM_REQUEST_FAILED', 'TIDAL_REQUEST_FAILED']);
  database.close();
});

test('a scan failure cannot mask later TIDAL authorization loss', async () => {
  const database = new Database(':memory:');
  let pages = 0;
  const xm = { async page() {
    pages += 1;
    if (pages === 2) throw new AppError('XM_REQUEST_FAILED', 'scan failed', { service: 'xmplaylist' });
    return { results: [rawPlay('play', '2026-09-11T12:00:00.000Z')], next: 'https://xmplaylist.com/api/station/test?last=1' };
  } };
  const tidal = makeTidal();
  tidal.validateTrack = async () => {
    throw new AppError('TIDAL_REAUTH_REQUIRED', 'reauthorize', { authRequired: true, service: 'tidal' });
  };
  const engine = new SyncEngine(database, xm, tidal, { clock: () => new Date('2026-09-11T13:00:00.000Z') });

  const result = await engine.run('manual', channel);

  assert.equal(result.error.code, 'TIDAL_REAUTH_REQUIRED');
  assert.equal(result.error.authRequired, true);
  assert.equal(database.runItems(result.id)[0].error_code, 'XM_REQUEST_FAILED');
  database.close();
});

test('an exhausted xmplaylist rate limit crosses the real engine boundary without cancelling the next channel', async () => {
  const database = new Database(':memory:');
  const calls = [];
  const xm = new XmPlaylistClient({
    sleepImpl: async () => {},
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).includes('/station/first')) return new Response('{}', { status: 429 });
      return Response.json({ results: [], next: null });
    },
  });
  const engine = new SyncEngine(database, xm, makeTidal(), { clock: () => new Date('2026-09-11T13:00:00.000Z') });
  const coordinator = new RunCoordinator(engine);
  coordinator.requestSweep('manual', [
    { id: 'first', deeplink: 'first', name: 'First', number: '1' },
    { id: 'second', deeplink: 'second', name: 'Second', number: '2' },
  ]);
  await waitForIdle(coordinator);

  assert.equal(calls.filter((url) => url.includes('/station/first')).length, 3);
  assert.equal(calls.filter((url) => url.includes('/station/second')).length, 1);
  assert.equal(coordinator.accountError, null);
  database.close();
});

test('a real TIDAL rate limit from the engine cancels queued channels', async () => {
  const database = new Database(':memory:');
  database.saveTokens({
    userId: 'user', accessToken: 'access', refreshToken: 'refresh', tokenType: 'Bearer', scopes: [],
    expiresAt: '2099-01-01T00:00:00.000Z', updatedAt: new Date().toISOString(),
  });
  const scanned = [];
  const xm = { async page(deeplink) {
    scanned.push(deeplink);
    return { results: [rawPlay(`play-${deeplink}`, '2026-09-11T12:00:00.000Z')], next: null };
  } };
  let tidalCalls = 0;
  const tidal = new TidalClient(database, {
    requestIntervalMs: 0,
    fetchImpl: async () => {
      tidalCalls += 1;
      return new Response('{}', { status: 429, headers: { 'Retry-After': '30' } });
    },
  });
  const engine = new SyncEngine(database, xm, tidal, { clock: () => new Date('2026-09-11T13:00:00.000Z') });
  const coordinator = new RunCoordinator(engine);
  coordinator.requestSweep('manual', [
    { id: 'first', deeplink: 'first', name: 'First', number: '1' },
    { id: 'second', deeplink: 'second', name: 'Second', number: '2' },
  ]);
  await waitForIdle(coordinator);

  assert.deepEqual(scanned, ['first']);
  assert.equal(tidalCalls, 1);
  assert.equal(coordinator.accountError.code, 'TIDAL_REQUEST_FAILED');
  database.close();
});

test('an unexpected scan failure performs no TIDAL work and stops the coordinator', async () => {
  const database = new Database(':memory:');
  const scanned = [];
  const xm = { async page(deeplink) {
    scanned.push(deeplink);
    throw new Error('database invariant failed');
  } };
  const tidal = makeTidal();
  let tidalCalls = 0;
  tidal.validateTrack = async () => { tidalCalls += 1; return null; };
  const engine = new SyncEngine(database, xm, tidal, { clock: () => new Date('2026-09-11T13:00:00.000Z') });
  const coordinator = new RunCoordinator(engine);
  coordinator.requestSweep('manual', [
    { id: 'first', deeplink: 'first', name: 'First', number: '1' },
    { id: 'second', deeplink: 'second', name: 'Second', number: '2' },
  ]);
  await waitForIdle(coordinator);

  assert.deepEqual(scanned, ['first']);
  assert.equal(tidalCalls, 0);
  assert.equal(coordinator.queued.length, 0);
  database.close();
});
