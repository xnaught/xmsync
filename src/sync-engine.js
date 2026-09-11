import { randomUUID } from 'node:crypto';
import { IDEMPOTENCY_WINDOW_MS } from './constants.js';
import { AppError } from './errors.js';
import { parseXmCursor, normalizePlay } from './xmplaylist.js';
import { chunk, nowIso, playlistDescription, playlistName, stableHash, yesterdayMidnight } from './util.js';

function sourceFromRow(row) {
  return { title: row.title, artists: JSON.parse(row.artists_json) };
}

function runItemFromPlay(play, outcome, fields = {}) {
  const artists = JSON.parse(play.artists_json);
  return {
    playId: play.play_id,
    outcome,
    matchMethod: fields.matchMethod ?? play.match_method,
    airplayAt: play.airplay_at,
    artist: artists.join(', '),
    title: play.title,
    errorCode: fields.errorCode,
    errorMessage: fields.errorMessage,
  };
}

export class SyncEngine {
  constructor(database, xm, tidal, options = {}) {
    this.database = database;
    this.xm = xm;
    this.tidal = tidal;
    this.clock = options.clock ?? (() => new Date());
  }

  async scan(channel, cutoff, runStart, runId, counts) {
    const scan = this.database.getScanState(channel.id);
    const stopAt = scan?.watermark && Date.parse(scan.watermark) > cutoff.getTime() ? new Date(scan.watermark) : cutoff;
    let cursor = null;
    let complete = false;
    do {
      const page = await this.xm.page(channel.deeplink, cursor);
      let oldest = null;
      for (const raw of page.results) {
        try {
          const play = normalizePlay(raw, channel.id);
          const instant = new Date(play.timestamp);
          if (!oldest || instant < oldest) oldest = instant;
          if (instant < cutoff || instant > runStart) continue;
          counts.fetched += 1;
          if (!this.database.insertPlay(play, nowIso())) counts.alreadyProcessed += 1;
        } catch (error) {
          counts.failed += 1;
          this.database.addRunItem(runId, {
            outcome: 'failed',
            errorCode: error.code ?? 'XM_MALFORMED_PLAY',
            errorMessage: error.message,
          });
        }
      }
      if ((oldest && oldest < stopAt) || page.next === null) {
        complete = true;
        break;
      }
      cursor = parseXmCursor(page.next, channel.deeplink);
      if (!cursor) {
        complete = true;
        break;
      }
    } while (true);

    if (complete) this.database.advanceScanState(channel.id, runStart.toISOString(), nowIso());
  }

  async resolve(play, runId, counts) {
    const source = sourceFromRow(play);
    const sourceIdentity = JSON.stringify([source.title, source.artists]);
    const cached = this.database.mapping(play.xm_track_id, sourceIdentity);
    let trackId = cached?.tidal_track_id ?? null;
    let method = cached?.method ?? null;

    try {
      if (!trackId && play.tidal_link) {
        trackId = await this.tidal.validateTrack(play.tidal_link);
        if (trackId) method = 'direct_link';
      }
      if (!trackId) {
        const candidate = await this.tidal.searchTrack(source);
        trackId = candidate?.id ?? null;
        if (trackId) method = 'search';
      }
      if (!trackId) {
        counts.skipped += 1;
        const message = 'No TIDAL track was found.';
        this.database.setPlayOutcome(play.play_id, 'skipped', { errorCode: 'NO_TIDAL_MATCH', errorMessage: message }, nowIso());
        this.database.addRunItem(runId, runItemFromPlay(play, 'skipped', { errorCode: 'NO_TIDAL_MATCH', errorMessage: message }));
        return null;
      }

      this.database.saveMapping({
        trackId: play.xm_track_id,
        sourceIdentity,
        tidalTrackId: trackId,
        method,
        resolvedAt: nowIso(),
        validationState: 'available_us',
      });
      this.database.setPlayResolved(play.play_id, trackId, method, nowIso());
      if (method === 'direct_link') counts.directMatched += 1;
      else counts.searchMatched += 1;
      return { ...play, tidal_track_id: trackId, match_method: method };
    } catch (error) {
      counts.failed += 1;
      this.database.setPlayOutcome(play.play_id, 'failed', { errorCode: error.code ?? 'RESOLUTION_FAILED', errorMessage: error.message }, nowIso());
      this.database.addRunItem(runId, runItemFromPlay(play, 'failed', {
        errorCode: error.code ?? 'RESOLUTION_FAILED', errorMessage: error.message,
      }));
      if (error.authRequired || error.status === 429) throw error;
      return null;
    }
  }

  playlistOwnedByUser(resource) {
    const userId = this.database.tokens()?.user_id;
    const owners = resource?.relationships?.owners?.data;
    return Array.isArray(owners) && owners.some((owner) => owner.id === userId);
  }

  async ensurePlaylist(channel, date, runId) {
    const expectedName = playlistName(channel.name, date);
    const payload = JSON.stringify({ data: { type: 'playlists', attributes: {
      name: expectedName, description: playlistDescription(channel.name, date), accessType: 'UNLISTED',
    } } });
    const payloadHash = stableHash(payload);
    let batch = this.database.findPendingBatch('create_playlist', expectedName, payloadHash);
    const saved = this.database.playlist(channel.id, date);
    if (saved) {
      try {
        const resource = await this.tidal.getPlaylist(saved.tidal_playlist_id);
        if (resource.attributes?.name === expectedName && this.playlistOwnedByUser(resource)) {
          this.database.savePlaylist({
            channelId: channel.id, localDate: date, expectedName, playlistId: resource.id,
            source: saved.source, createdAt: saved.created_at, lastSeenAt: nowIso(),
          });
          return resource.id;
        }
      } catch (error) {
        if (error.status !== 404) throw error;
      }
      this.database.deletePlaylistMapping(channel.id, date);
    }

    const matches = (await this.tidal.allOwnedPlaylists()).filter((playlist) => playlist.attributes?.name === expectedName);
    if (matches.length > 1) {
      throw new AppError('PLAYLIST_NAME_AMBIGUOUS', `Multiple owned TIDAL playlists are named "${expectedName}". Rename the extras and retry.`, { unsafeWrite: true });
    }
    if (matches.length === 1) {
      const playlist = matches[0];
      this.database.transaction(() => {
        this.database.savePlaylist({
          channelId: channel.id, localDate: date, expectedName, playlistId: playlist.id,
          source: batch ? 'created' : 'adopted', createdAt: nowIso(), lastSeenAt: nowIso(),
        });
        if (batch) this.database.completeBatch(batch.id, { recoveredByExactName: true, playlistId: playlist.id }, nowIso());
      });
      if (batch) return playlist.id;
      const visibility = playlist.attributes?.accessType;
      const warning = visibility === 'PUBLIC'
        ? 'Adopted an existing public playlist; its visibility was not changed.'
        : 'Adopted an existing same-name playlist; existing contents were not reconciled.';
      this.database.addRunItem(runId, { outcome: 'warning', errorCode: 'PLAYLIST_ADOPTED', errorMessage: warning });
      return playlist.id;
    }

    if (batch?.attempted_at && Date.now() - Date.parse(batch.attempted_at) >= IDEMPOTENCY_WINDOW_MS) {
      this.database.ambiguousBatch(batch.id, { message: 'The playlist-create outcome could not be confirmed.' }, nowIso());
      throw new AppError('AMBIGUOUS_PLAYLIST_CREATE', `A previous attempt to create "${expectedName}" has an ambiguous outcome. Check TIDAL before retrying.`, { unsafeWrite: true });
    }
    if (!batch) {
      const id = this.database.createBatch({
        operation: 'create_playlist', targetId: expectedName, idempotencyKey: randomUUID(), payload,
        payloadHash, playIds: [], createdAt: nowIso(),
      });
      batch = { id, idempotency_key: this.database.db.prepare('SELECT idempotency_key FROM write_batches WHERE id=?').get(id).idempotency_key };
    }
    this.database.attemptedBatch(batch.id, nowIso());
    const response = await this.tidal.createPlaylist(expectedName, playlistDescription(channel.name, date), batch.idempotency_key);
    const playlistId = response?.data?.id;
    if (!playlistId) throw new AppError('TIDAL_INVALID_RESPONSE', 'TIDAL did not return the created playlist ID.', { unsafeWrite: true });
    this.database.transaction(() => {
      this.database.savePlaylist({
        channelId: channel.id, localDate: date, expectedName, playlistId,
        source: 'created', createdAt: nowIso(), lastSeenAt: nowIso(),
      });
      this.database.completeBatch(batch.id, response, nowIso());
    });
    return playlistId;
  }

  recoverOldAddBatch(batch, playlistId, plays, runId, counts) {
    return this.tidal.playlistItems(playlistId).then((items) => {
      const precondition = JSON.parse(batch.precondition_json ?? 'null');
      const segment = precondition ? items.slice(precondition.count, precondition.count + plays.length) : [];
      const anchorMatches = precondition?.count === 0 || (precondition?.tailItemId &&
        items[precondition.count - 1]?.meta?.itemId === precondition.tailItemId);
      const matches = anchorMatches && segment.length === plays.length &&
        segment.every((item, index) => item.id === plays[index].tidal_track_id);
      if (!matches) {
        this.database.ambiguousBatch(batch.id, { message: 'Current playlist suffix did not prove the previous write.' }, nowIso());
        throw new AppError('AMBIGUOUS_PLAYLIST_WRITE', 'A previous playlist write has an ambiguous outcome. Review the playlist before changing local state.', { unsafeWrite: true });
      }
      this.database.transaction(() => {
        plays.forEach((play, index) => {
          this.database.setPlayOutcome(play.play_id, 'synced', { playlistId, occurrenceId: segment[index].meta?.itemId }, nowIso());
          this.database.addRunItem(runId, runItemFromPlay(play, 'synced'));
        });
        this.database.completeBatch(batch.id, { recoveredFromPlaylistSuffix: true }, nowIso());
      });
      counts.synced += plays.length;
      return true;
    });
  }

  async writeBatch(playlistId, plays, runId, counts, existingBatch = null) {
    const payload = JSON.stringify({ data: plays.map((play) => ({ type: 'tracks', id: play.tidal_track_id })) });
    const payloadHash = stableHash(payload);
    const playIds = plays.map((play) => play.play_id);
    let batch = existingBatch ?? this.database.findPendingBatch('add_items', playlistId, payloadHash, playIds);
    if (batch?.attempted_at && Date.now() - Date.parse(batch.attempted_at) >= IDEMPOTENCY_WINDOW_MS) {
      await this.recoverOldAddBatch(batch, playlistId, plays, runId, counts);
      return;
    }
    if (!batch) {
      const existingItems = await this.tidal.playlistItems(playlistId);
      const tail = existingItems.at(-1);
      const idempotencyKey = randomUUID();
      const id = this.database.createBatch({
        operation: 'add_items', targetId: playlistId, idempotencyKey, payload, payloadHash,
        playIds, precondition: { count: existingItems.length, tailItemId: tail?.meta?.itemId ?? null }, createdAt: nowIso(),
      });
      batch = { id, idempotency_key: idempotencyKey };
    }

    this.database.attemptedBatch(batch.id, nowIso());
    let response;
    try {
      response = await this.tidal.addPlaylistItems(playlistId, plays.map((play) => ({ trackId: play.tidal_track_id })), batch.idempotency_key);
    } catch (error) {
      for (const play of plays) {
        counts.failed += 1;
        this.database.setPlayOutcome(play.play_id, 'failed', { errorCode: error.code ?? 'PLAYLIST_WRITE_FAILED', errorMessage: error.message }, nowIso());
        this.database.addRunItem(runId, runItemFromPlay(play, 'failed', { errorCode: error.code ?? 'PLAYLIST_WRITE_FAILED', errorMessage: error.message }));
      }
      throw error;
    }

    const successes = new Map();
    for (const item of response.data ?? []) {
      const queue = successes.get(item.id) ?? [];
      queue.push(item);
      successes.set(item.id, queue);
    }
    const skipped = new Map();
    for (const item of response.meta?.skipped ?? []) {
      const queue = skipped.get(item.id) ?? [];
      queue.push(item.reason ?? 'SKIPPED');
      skipped.set(item.id, queue);
    }

    const outcomes = plays.map((play) => {
      const success = successes.get(play.tidal_track_id)?.shift();
      if (success) return { type: 'synced', item: success };
      const reason = skipped.get(play.tidal_track_id)?.shift();
      if (reason) return { type: 'skipped', reason };
      return { type: 'unknown' };
    });
    const mixedDuplicate = [...new Set(plays.map((play) => play.tidal_track_id))].some((trackId) => {
      const matching = plays.map((play, index) => play.tidal_track_id === trackId ? outcomes[index].type : null).filter(Boolean);
      return new Set(matching).size > 1;
    });
    const ambiguous = outcomes.some((outcome) => outcome.type === 'unknown') || mixedDuplicate;

    this.database.transaction(() => {
      for (let index = 0; index < plays.length; index += 1) {
        const play = plays[index];
        const outcome = outcomes[index];
        if (outcome.type === 'synced') {
          counts.synced += 1;
          this.database.setPlayOutcome(play.play_id, 'synced', { playlistId, occurrenceId: outcome.item.meta?.itemId }, nowIso());
          this.database.addRunItem(runId, runItemFromPlay(play, 'synced'));
        } else if (outcome.type === 'skipped') {
          counts.skipped += 1;
          const reason = `TIDAL skipped this playlist item: ${outcome.reason}.`;
          this.database.setPlayOutcome(play.play_id, 'skipped', { playlistId, errorCode: 'TIDAL_ITEM_SKIPPED', errorMessage: reason }, nowIso());
          this.database.addRunItem(runId, runItemFromPlay(play, 'skipped', { errorCode: 'TIDAL_ITEM_SKIPPED', errorMessage: reason }));
        } else {
          counts.failed += 1;
          const reason = 'TIDAL did not report an outcome for this playlist item.';
          this.database.setPlayOutcome(play.play_id, 'failed', { errorCode: 'TIDAL_ITEM_UNKNOWN', errorMessage: reason }, nowIso());
          this.database.addRunItem(runId, runItemFromPlay(play, 'failed', { errorCode: 'TIDAL_ITEM_UNKNOWN', errorMessage: reason }));
        }
      }
      if (ambiguous) this.database.ambiguousBatch(batch.id, response, nowIso());
      else this.database.completeBatch(batch.id, response, nowIso());
    });
    if (ambiguous) throw new AppError('AMBIGUOUS_PLAYLIST_WRITE', 'TIDAL did not report every playlist item outcome. The batch was not retried.', { unsafeWrite: true });
  }

  async run(trigger, channel) {
    const runStart = this.clock();
    const cutoff = yesterdayMidnight(runStart);
    const runId = this.database.createRun(trigger, channel, runStart.toISOString());
    const counts = { fetched: 0, alreadyProcessed: 0, directMatched: 0, searchMatched: 0, synced: 0, skipped: 0, failed: 0 };
    let topError = null;

    try {
      try {
        await this.scan(channel, cutoff, runStart, runId, counts);
      } catch (error) {
        topError = error;
        counts.failed += 1;
        this.database.addRunItem(runId, { outcome: 'failed', errorCode: error.code ?? 'SCAN_FAILED', errorMessage: error.message });
      }

      const pending = this.database.processablePlays(channel.id);
      const resolved = [];
      for (const play of pending) {
        const result = await this.resolve(play, runId, counts);
        if (result) resolved.push(result);
      }

      const remaining = new Map(resolved.map((play) => [play.play_id, play]));
      let blockWrites = false;
      for (const batch of this.database.pendingAddBatches()) {
        const playIds = JSON.parse(batch.play_ids_json);
        const batchPlays = playIds.map((id) => remaining.get(id));
        if (batchPlays.some((play) => !play)) continue;
        try {
          await this.writeBatch(batch.target_id, batchPlays, runId, counts, batch);
          playIds.forEach((id) => remaining.delete(id));
        } catch (error) {
          topError ??= error;
          playIds.forEach((id) => remaining.delete(id));
          if (error.authRequired || error.unsafeWrite || error.status === 429) {
            blockWrites = true;
            break;
          }
        }
      }

      const byDate = Map.groupBy([...remaining.values()], (play) => play.local_date);
      for (const [date, plays] of blockWrites ? [] : byDate) {
        try {
          const playlistId = await this.ensurePlaylist(channel, date, runId);
          for (const batch of chunk(plays, 50)) await this.writeBatch(playlistId, batch, runId, counts);
        } catch (error) {
          topError ??= error;
          for (const play of plays.filter((item) => item.status !== 'synced')) {
            const latest = this.database.db.prepare('SELECT status FROM plays WHERE play_id=?').get(play.play_id);
            if (latest?.status !== 'pending') continue;
            counts.failed += 1;
            this.database.setPlayOutcome(play.play_id, 'failed', { errorCode: error.code ?? 'PLAYLIST_FAILED', errorMessage: error.message }, nowIso());
            this.database.addRunItem(runId, runItemFromPlay(play, 'failed', { errorCode: error.code ?? 'PLAYLIST_FAILED', errorMessage: error.message }));
          }
          if (error.authRequired || error.unsafeWrite || error.status === 429) break;
        }
      }
    } catch (error) {
      topError ??= error;
    }

    if (!topError && counts.failed) topError = new AppError('SYNC_ITEMS_FAILED', 'One or more airplays failed and will be retried.');
    const status = topError ? (counts.synced || counts.skipped ? 'partial' : 'failed') : 'completed';
    this.database.finishRun(runId, status, counts, nowIso(), topError?.message ?? null);
    return { id: runId, status, counts, error: topError };
  }
}
