import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Database } from '../src/database.js';

test('database binds history to the first connected TIDAL user', () => {
  const database = new Database(':memory:');
  const token = {
    userId: 'user-1', accessToken: 'access', refreshToken: 'refresh', tokenType: 'Bearer',
    scopes: ['user.read'], expiresAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-11T00:00:00.000Z',
  };
  database.saveTokens(token);
  assert.equal(database.tokens().user_id, 'user-1');
  assert.throws(() => database.saveTokens({ ...token, userId: 'user-2' }), /does not own this database/);
  database.clearTokens();
  assert.equal(database.tokens(), undefined);
  assert.equal(database.settings().account_user_id, 'user-1');
  database.close();
});

test('plays deduplicate by channel and play ID rather than track ID', () => {
  const database = new Database(':memory:');
  const common = {
    channelId: 'channel', timestamp: '2026-09-11T12:00:00.000Z', localDate: '2026-09-11',
    trackId: 'same-track', title: 'Song', artists: ['Artist'], tidalLink: '123',
  };
  assert.equal(database.insertPlay({ ...common, id: 'play-1' }, common.timestamp), true);
  assert.equal(database.insertPlay({ ...common, id: 'play-1' }, common.timestamp), false);
  assert.equal(database.insertPlay({ ...common, id: 'play-2' }, common.timestamp), true);
  assert.equal(database.insertPlay({ ...common, channelId: 'other', id: 'play-1' }, common.timestamp), true);
  assert.equal(database.processablePlays('channel', '2026-09-10T00:00:00.000Z').length, 2);
  assert.equal(database.processablePlays('other').length, 1);
  database.setPlayOutcome('channel', 'play-1', 'skipped', {}, common.timestamp);
  assert.equal(database.play('channel', 'play-1').status, 'skipped');
  assert.equal(database.play('other', 'play-1').status, 'pending');
  database.close();
});

test('selected channels are replaced atomically in persisted order and retained when deselected', () => {
  const database = new Database(':memory:');
  const channels = [
    { id: 'a', deeplink: 'A', name: 'Alpha', number: 1, playlistLabel: 'Alpha' },
    { id: 'b', deeplink: 'B', name: 'Beta', number: 2, playlistLabel: 'Beta' },
  ];
  database.replaceSelectedChannels(channels);
  assert.deepEqual(database.selectedChannels().map((channel) => channel.id), ['a', 'b']);
  database.replaceSelectedChannels([channels[1]]);
  assert.deepEqual(database.selectedChannels().map((channel) => channel.id), ['b']);
  assert.deepEqual(database.persistedChannels().map((channel) => channel.id).sort(), ['a', 'b']);
  assert.throws(() => database.replaceSelectedChannels(Array.from({ length: 11 }, (_, index) => ({
    id: String(index), deeplink: String(index), name: String(index), number: index, playlistLabel: String(index),
  }))), /ten channels/);
  assert.deepEqual(database.selectedChannels().map((channel) => channel.id), ['b']);
  database.close();
});

test('schema version 1 migrates channel, play, run, playlist, and active batch ownership', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'xmsync-migration-'));
  const path = join(directory, 'legacy.sqlite');
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE settings (id INTEGER PRIMARY KEY, tidal_client_id TEXT, tidal_client_secret TEXT,
      channel_id TEXT, channel_deeplink TEXT, channel_name TEXT, channel_number TEXT,
      scheduler_enabled INTEGER NOT NULL DEFAULT 0, account_user_id TEXT, settings_version INTEGER DEFAULT 1);
    INSERT INTO settings VALUES (1, 'client', 'secret', 'station', 'station', 'Station', '7', 1, 'user', 1);
    CREATE TABLE playlists (channel_id TEXT NOT NULL, local_date TEXT NOT NULL, expected_name TEXT NOT NULL,
      tidal_playlist_id TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
      PRIMARY KEY(channel_id, local_date));
    INSERT INTO playlists VALUES ('station', '2026-09-11', 'Station - 2026-09-11', 'playlist', 'created', 'now', 'now');
    CREATE TABLE plays (play_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, airplay_at TEXT NOT NULL,
      local_date TEXT NOT NULL, xm_track_id TEXT NOT NULL, title TEXT NOT NULL, artists_json TEXT NOT NULL,
      tidal_link TEXT, tidal_track_id TEXT, match_method TEXT, status TEXT NOT NULL, playlist_id TEXT,
      occurrence_id TEXT, error_code TEXT, error_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO plays VALUES ('play', 'station', '2026-09-11T12:00:00Z', '2026-09-11', 'track', 'Song', '["Artist"]',
      NULL, 'tidal-track', 'search', 'failed', NULL, NULL, NULL, NULL, 'now', 'now');
    CREATE TABLE write_batches (id INTEGER PRIMARY KEY AUTOINCREMENT, operation TEXT NOT NULL, target_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, payload_hash TEXT NOT NULL, play_ids_json TEXT NOT NULL,
      precondition_json TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, attempted_at TEXT, completed_at TEXT, response_json TEXT);
    INSERT INTO write_batches VALUES (1, 'add_items', 'playlist', 'key', '{}', 'hash', '["play"]', NULL, 'pending', 'now', NULL, NULL, NULL);
    CREATE TABLE sync_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, trigger TEXT NOT NULL, channel_id TEXT NOT NULL,
      channel_name TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, status TEXT NOT NULL, fetched INTEGER DEFAULT 0,
      already_processed INTEGER DEFAULT 0, direct_matched INTEGER DEFAULT 0, search_matched INTEGER DEFAULT 0,
      synced INTEGER DEFAULT 0, skipped INTEGER DEFAULT 0, failed INTEGER DEFAULT 0, error_message TEXT);
    INSERT INTO sync_runs (trigger, channel_id, channel_name, started_at, status) VALUES ('manual', 'station', 'Station', 'now', 'completed');
    PRAGMA user_version=1;
  `);
  legacy.close();
  const unsafePath = join(directory, 'unsafe.sqlite');
  copyFileSync(path, unsafePath);
  const unsafe = new DatabaseSync(unsafePath);
  unsafe.exec(`
    INSERT INTO sync_runs (trigger, channel_id, channel_name, started_at, status) VALUES ('manual', 'old-station', 'Old Station', 'now', 'completed');
    INSERT INTO write_batches VALUES (2, 'create_playlist', 'Station - 2026-09-11', 'key-2', '{}', 'hash-2', '[]', NULL, 'pending', 'now', NULL, NULL, NULL);
  `);
  unsafe.close();
  assert.throws(() => new Database(unsafePath), /Cannot safely assign active legacy write batch 2/);
  const rolledBack = new DatabaseSync(unsafePath);
  assert.equal(rolledBack.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(rolledBack.prepare("SELECT count(*) count FROM sqlite_master WHERE type='table' AND name='channels'").get().count, 0);
  rolledBack.close();

  const database = new Database(path);
  assert.equal(database.db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.equal(database.selectedChannels()[0].playlistLabel, 'Station');
  assert.equal(database.play('station', 'play').status, 'failed');
  const batch = database.pendingAddBatches('station')[0];
  assert.equal(batch.local_date, '2026-09-11');
  assert.equal(database.latestRun().channel_number, null);
  database.close();
});
