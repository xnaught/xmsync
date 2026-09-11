import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIGRATION = `
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  tidal_client_id TEXT,
  tidal_client_secret TEXT,
  channel_id TEXT,
  channel_deeplink TEXT,
  channel_name TEXT,
  channel_number TEXT,
  scheduler_enabled INTEGER NOT NULL DEFAULT 0 CHECK (scheduler_enabled IN (0, 1)),
  account_user_id TEXT,
  settings_version INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO settings (id) VALUES (1);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  user_id TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  token_type TEXT NOT NULL,
  scopes TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_pending (
  state TEXT PRIMARY KEY,
  verifier TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS playlists (
  channel_id TEXT NOT NULL,
  local_date TEXT NOT NULL,
  expected_name TEXT NOT NULL,
  tidal_playlist_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('created', 'adopted')),
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, local_date)
);

CREATE TABLE IF NOT EXISTS track_mappings (
  xm_track_id TEXT NOT NULL,
  source_identity TEXT NOT NULL,
  tidal_track_id TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('direct_link', 'search')),
  resolved_at TEXT NOT NULL,
  validation_state TEXT NOT NULL,
  PRIMARY KEY (xm_track_id, source_identity)
);

CREATE TABLE IF NOT EXISTS plays (
  play_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  airplay_at TEXT NOT NULL,
  local_date TEXT NOT NULL,
  xm_track_id TEXT NOT NULL,
  title TEXT NOT NULL,
  artists_json TEXT NOT NULL,
  tidal_link TEXT,
  tidal_track_id TEXT,
  match_method TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'synced', 'skipped', 'failed')),
  playlist_id TEXT,
  occurrence_id TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS plays_process_idx ON plays(channel_id, status, airplay_at);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  channel_name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL,
  fetched INTEGER NOT NULL DEFAULT 0,
  already_processed INTEGER NOT NULL DEFAULT 0,
  direct_matched INTEGER NOT NULL DEFAULT 0,
  search_matched INTEGER NOT NULL DEFAULT 0,
  synced INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS run_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
  play_id TEXT,
  outcome TEXT NOT NULL,
  match_method TEXT,
  airplay_at TEXT,
  artist TEXT,
  title TEXT,
  error_code TEXT,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS run_items_run_idx ON run_items(run_id);

CREATE TABLE IF NOT EXISTS write_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation TEXT NOT NULL,
  target_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  play_ids_json TEXT NOT NULL,
  precondition_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'ambiguous')),
  created_at TEXT NOT NULL,
  attempted_at TEXT,
  completed_at TEXT,
  response_json TEXT
);

CREATE TABLE IF NOT EXISTS channel_scan_state (
  channel_id TEXT PRIMARY KEY,
  watermark TEXT NOT NULL,
  last_complete_at TEXT NOT NULL
);
PRAGMA user_version = 1;
`;

export class Database {
  constructor(path = 'data/xmsync.sqlite') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { timeout: 5_000 });
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) throw new Error(`Database schema version ${version} is newer than this application supports.`);
    if (version === 0) this.transaction(() => this.db.exec(MIGRATION));
  }

  close() {
    this.db.close();
  }

  transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  settings() {
    return this.db.prepare('SELECT * FROM settings WHERE id = 1').get();
  }

  saveCredentials(clientId, clientSecret) {
    this.db.prepare('UPDATE settings SET tidal_client_id = ?, tidal_client_secret = ? WHERE id = 1').run(clientId, clientSecret);
  }

  saveChannel(channel) {
    this.db.prepare(`UPDATE settings SET channel_id = ?, channel_deeplink = ?, channel_name = ?, channel_number = ? WHERE id = 1`)
      .run(channel.id, channel.deeplink.toLowerCase(), channel.name, String(channel.number));
  }

  setSchedulerEnabled(enabled) {
    this.db.prepare('UPDATE settings SET scheduler_enabled = ? WHERE id = 1').run(enabled ? 1 : 0);
  }

  savePendingOAuth(state, verifier, createdAt) {
    this.db.prepare('DELETE FROM oauth_pending WHERE created_at < ?').run(new Date(Date.parse(createdAt) - 10 * 60_000).toISOString());
    this.db.prepare('INSERT INTO oauth_pending (state, verifier, created_at) VALUES (?, ?, ?)').run(state, verifier, createdAt);
  }

  consumePendingOAuth(state) {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM oauth_pending WHERE state = ?').get(state);
      if (row) this.db.prepare('DELETE FROM oauth_pending WHERE state = ?').run(state);
      return row;
    });
  }

  tokens() {
    return this.db.prepare('SELECT * FROM oauth_tokens WHERE id = 1').get();
  }

  saveTokens(tokens) {
    this.transaction(() => {
      const settings = this.settings();
      if (settings.account_user_id && settings.account_user_id !== tokens.userId) {
        throw new Error('The authorized TIDAL account does not own this database.');
      }
      this.db.prepare('UPDATE settings SET account_user_id = ? WHERE id = 1').run(tokens.userId);
      this.db.prepare(`INSERT INTO oauth_tokens
        (id, user_id, access_token, refresh_token, token_type, scopes, expires_at, updated_at)
        VALUES (1, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id, access_token=excluded.access_token,
        refresh_token=excluded.refresh_token, token_type=excluded.token_type, scopes=excluded.scopes,
        expires_at=excluded.expires_at, updated_at=excluded.updated_at`)
        .run(tokens.userId, tokens.accessToken, tokens.refreshToken ?? null, tokens.tokenType, tokens.scopes.join(' '), tokens.expiresAt, tokens.updatedAt);
    });
  }

  clearTokens() {
    this.db.prepare('DELETE FROM oauth_tokens').run();
  }

  getScanState(channelId) {
    return this.db.prepare('SELECT * FROM channel_scan_state WHERE channel_id = ?').get(channelId);
  }

  advanceScanState(channelId, watermark, completedAt) {
    this.db.prepare(`INSERT INTO channel_scan_state (channel_id, watermark, last_complete_at) VALUES (?, ?, ?)
      ON CONFLICT(channel_id) DO UPDATE SET watermark=excluded.watermark, last_complete_at=excluded.last_complete_at`)
      .run(channelId, watermark, completedAt);
  }

  insertPlay(play, timestamp) {
    const result = this.db.prepare(`INSERT OR IGNORE INTO plays
      (play_id, channel_id, airplay_at, local_date, xm_track_id, title, artists_json, tidal_link, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .run(play.id, play.channelId, play.timestamp, play.localDate, play.trackId, play.title, JSON.stringify(play.artists), play.tidalLink, timestamp, timestamp);
    return result.changes === 1;
  }

  processablePlays(channelId) {
    return this.db.prepare(`SELECT p.* FROM plays p
      WHERE p.channel_id = ? AND p.status IN ('pending', 'failed')
      AND NOT EXISTS (
        SELECT 1 FROM write_batches wb, json_each(wb.play_ids_json) ids
        WHERE wb.status = 'ambiguous' AND ids.value = p.play_id
      )
      ORDER BY p.airplay_at, p.play_id`).all(channelId);
  }

  setPlayResolved(playId, trackId, method, timestamp) {
    this.db.prepare(`UPDATE plays SET tidal_track_id=?, match_method=?, status='pending', error_code=NULL, error_message=NULL, updated_at=? WHERE play_id=?`)
      .run(trackId, method, timestamp, playId);
  }

  setPlayOutcome(playId, status, fields, timestamp) {
    this.db.prepare(`UPDATE plays SET status=?, playlist_id=?, occurrence_id=?, error_code=?, error_message=?, updated_at=? WHERE play_id=?`)
      .run(status, fields.playlistId ?? null, fields.occurrenceId ?? null, fields.errorCode ?? null, fields.errorMessage ?? null, timestamp, playId);
  }

  mapping(trackId, sourceIdentity) {
    return this.db.prepare('SELECT * FROM track_mappings WHERE xm_track_id = ? AND source_identity = ?').get(trackId, sourceIdentity);
  }

  saveMapping(mapping) {
    this.db.prepare(`INSERT INTO track_mappings
      (xm_track_id, source_identity, tidal_track_id, method, resolved_at, validation_state)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(xm_track_id, source_identity) DO UPDATE SET tidal_track_id=excluded.tidal_track_id,
      method=excluded.method, resolved_at=excluded.resolved_at, validation_state=excluded.validation_state`)
      .run(mapping.trackId, mapping.sourceIdentity, mapping.tidalTrackId, mapping.method, mapping.resolvedAt, mapping.validationState);
  }

  playlist(channelId, localDate) {
    return this.db.prepare('SELECT * FROM playlists WHERE channel_id = ? AND local_date = ?').get(channelId, localDate);
  }

  savePlaylist(mapping) {
    this.db.prepare(`INSERT INTO playlists
      (channel_id, local_date, expected_name, tidal_playlist_id, source, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(channel_id, local_date) DO UPDATE SET expected_name=excluded.expected_name,
      tidal_playlist_id=excluded.tidal_playlist_id, source=excluded.source, last_seen_at=excluded.last_seen_at`)
      .run(mapping.channelId, mapping.localDate, mapping.expectedName, mapping.playlistId, mapping.source, mapping.createdAt, mapping.lastSeenAt);
  }

  deletePlaylistMapping(channelId, localDate) {
    this.db.prepare('DELETE FROM playlists WHERE channel_id = ? AND local_date = ?').run(channelId, localDate);
  }

  createRun(trigger, channel, startedAt) {
    return Number(this.db.prepare(`INSERT INTO sync_runs (trigger, channel_id, channel_name, started_at, status) VALUES (?, ?, ?, ?, 'running')`)
      .run(trigger, channel.id, channel.name, startedAt).lastInsertRowid);
  }

  finishRun(runId, status, counts, endedAt, errorMessage = null) {
    this.db.prepare(`UPDATE sync_runs SET ended_at=?, status=?, fetched=?, already_processed=?, direct_matched=?,
      search_matched=?, synced=?, skipped=?, failed=?, error_message=? WHERE id=?`)
      .run(endedAt, status, counts.fetched, counts.alreadyProcessed, counts.directMatched, counts.searchMatched,
        counts.synced, counts.skipped, counts.failed, errorMessage, runId);
  }

  addRunItem(runId, item) {
    this.db.prepare(`INSERT INTO run_items
      (run_id, play_id, outcome, match_method, airplay_at, artist, title, error_code, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(runId, item.playId ?? null, item.outcome, item.matchMethod ?? null, item.airplayAt ?? null,
        item.artist ?? null, item.title ?? null, item.errorCode ?? null, item.errorMessage ?? null);
  }

  recentRuns(limit = 20) {
    return this.db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT ?').all(limit);
  }

  runItems(runId) {
    return this.db.prepare('SELECT * FROM run_items WHERE run_id = ? ORDER BY id').all(runId);
  }

  latestRun() {
    return this.db.prepare('SELECT * FROM sync_runs WHERE status != ? ORDER BY id DESC LIMIT 1').get('running');
  }

  findPendingBatch(operation, targetId, payloadHash, playIds = []) {
    return this.db.prepare(`SELECT * FROM write_batches
      WHERE operation=? AND target_id=? AND payload_hash=? AND play_ids_json=? AND status='pending'
      ORDER BY id DESC LIMIT 1`).get(operation, targetId, payloadHash, JSON.stringify(playIds));
  }

  pendingAddBatches() {
    return this.db.prepare(`SELECT * FROM write_batches WHERE operation='add_items' AND status='pending' ORDER BY id`).all();
  }

  createBatch(batch) {
    return Number(this.db.prepare(`INSERT INTO write_batches
      (operation, target_id, idempotency_key, payload, payload_hash, play_ids_json, precondition_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
      .run(batch.operation, batch.targetId, batch.idempotencyKey, batch.payload, batch.payloadHash,
        JSON.stringify(batch.playIds ?? []), batch.precondition ? JSON.stringify(batch.precondition) : null, batch.createdAt).lastInsertRowid);
  }

  attemptedBatch(id, timestamp) {
    this.db.prepare('UPDATE write_batches SET attempted_at=COALESCE(attempted_at, ?) WHERE id=?').run(timestamp, id);
  }

  completeBatch(id, response, timestamp) {
    this.db.prepare(`UPDATE write_batches SET status='completed', completed_at=?, response_json=? WHERE id=?`)
      .run(timestamp, JSON.stringify(response), id);
  }

  ambiguousBatch(id, response, timestamp) {
    this.db.prepare(`UPDATE write_batches SET status='ambiguous', completed_at=?, response_json=? WHERE id=?`)
      .run(timestamp, JSON.stringify(response), id);
  }
}
