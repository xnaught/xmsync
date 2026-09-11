import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../src/errors.js';
import { Database } from '../src/database.js';
import { SyncEngine } from '../src/sync-engine.js';

const channel = { id: 'station', deeplink: 'station', name: 'Station', number: '1' };
const raw = {
  id: 'play-1', timestamp: '2026-09-11T12:00:00.000Z',
  track: { id: 'xm-track', title: 'Song', artists: ['Artist'] },
  links: [{ site: 'tidal', url: 'https://tidal.com/track/track-1' }],
};

function databaseWithUser() {
  const database = new Database(':memory:');
  database.saveTokens({
    userId: 'user', accessToken: 'access', refreshToken: 'refresh', tokenType: 'Bearer', scopes: [],
    expiresAt: '2099-01-01T00:00:00.000Z', updatedAt: '2026-09-11T00:00:00.000Z',
  });
  return database;
}

test('completed batches allow identical track payloads for different airplay IDs', () => {
  const database = databaseWithUser();
  const common = { operation: 'add_items', targetId: 'playlist', payload: '{"same":true}', payloadHash: 'hash', createdAt: new Date().toISOString() };
  const first = database.createBatch({ ...common, idempotencyKey: 'key-1', playIds: ['play-1'] });
  database.completeBatch(first, {}, new Date().toISOString());
  const second = database.createBatch({ ...common, idempotencyKey: 'key-2', playIds: ['play-2'] });
  assert.doesNotThrow(() => database.completeBatch(second, {}, new Date().toISOString()));
  assert.equal(database.db.prepare("SELECT count(*) count FROM write_batches WHERE status='completed'").get().count, 2);
  database.close();
});

test('an uncertain write is recovered from its persisted pre-write anchor without sending twice', async () => {
  const database = databaseWithUser();
  const contents = [];
  let writes = 0;
  const xm = { async page() { return { results: [raw], next: null }; } };
  const tidal = {
    async validateTrack(id) { return id; },
    async allOwnedPlaylists() { return []; },
    async createPlaylist() { return { data: { id: 'playlist' } }; },
    async playlistItems() { return contents; },
    async addPlaylistItems(id, items) {
      writes += 1;
      contents.push({ type: 'tracks', id: items[0].trackId, meta: { itemId: 'new-occurrence' } });
      throw new AppError('NETWORK_ERROR', 'connection lost', { retryable: true, unsafeWrite: true });
    },
  };
  const engine = new SyncEngine(database, xm, tidal, { clock: () => new Date('2026-09-11T13:00:00.000Z') });
  await engine.run('manual', channel);
  database.db.prepare("UPDATE write_batches SET attempted_at='2026-09-11T00:00:00.000Z' WHERE operation='add_items'").run();

  const recovered = await engine.run('manual', channel);
  assert.equal(recovered.counts.synced, 1);
  assert.equal(writes, 1);
  assert.equal(database.db.prepare("SELECT status FROM plays WHERE play_id='play-1'").get().status, 'synced');
  database.close();
});

test('an old uncertain write is not inferred from a pre-existing identical suffix', async () => {
  const database = databaseWithUser();
  const contents = [{ type: 'tracks', id: 'track-1', meta: { itemId: 'old-occurrence' } }];
  let writes = 0;
  const xm = { async page() { return { results: [raw], next: null }; } };
  const tidal = {
    async validateTrack(id) { return id; },
    async allOwnedPlaylists() { return []; },
    async createPlaylist() { return { data: { id: 'playlist' } }; },
    async playlistItems() { return contents; },
    async addPlaylistItems() {
      writes += 1;
      throw new AppError('NETWORK_ERROR', 'request may not have arrived', { retryable: true, unsafeWrite: true });
    },
  };
  const engine = new SyncEngine(database, xm, tidal, { clock: () => new Date('2026-09-11T13:00:00.000Z') });
  await engine.run('manual', channel);
  database.db.prepare("UPDATE write_batches SET attempted_at='2026-09-11T00:00:00.000Z' WHERE operation='add_items'").run();

  const recovered = await engine.run('manual', channel);
  assert.equal(recovered.counts.synced, 0);
  assert.equal(writes, 1);
  assert.equal(database.db.prepare("SELECT status FROM write_batches WHERE operation='add_items'").get().status, 'ambiguous');
  assert.notEqual(database.db.prepare("SELECT status FROM plays WHERE play_id='play-1'").get().status, 'synced');
  database.close();
});
