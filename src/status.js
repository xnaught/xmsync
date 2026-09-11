import { maskSecret } from './util.js';

function mapRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    trigger: row.trigger,
    channelId: row.channel_id,
    channelName: row.channel_name,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    status: row.status,
    counts: {
      fetched: row.fetched,
      alreadyProcessed: row.already_processed,
      directMatched: row.direct_matched,
      searchMatched: row.search_matched,
      synced: row.synced,
      skipped: row.skipped,
      failed: row.failed,
    },
    error: row.error_message,
  };
}

export function settingsView(database) {
  const settings = database.settings();
  return {
    tidalConfigured: Boolean(settings.tidal_client_id && settings.tidal_client_secret),
    clientIdMasked: maskSecret(settings.tidal_client_id),
    clientSecretMasked: maskSecret(settings.tidal_client_secret),
    callbackUrl: 'http://localhost:8787/auth/tidal/callback',
  };
}

export function statusView(database, coordinator, scheduler) {
  const settings = database.settings();
  const tokens = database.tokens();
  const latest = mapRun(database.latestRun());
  const schedulerState = coordinator.active ? 'syncing' : coordinator.lastError ? 'error' : settings.scheduler_enabled ? 'running' : 'stopped';
  return {
    configured: Boolean(settings.tidal_client_id && settings.tidal_client_secret),
    auth: {
      connected: Boolean(tokens),
      userId: tokens?.user_id ?? null,
      scopes: tokens?.scopes?.split(/\s+/).filter(Boolean) ?? [],
      expiresAt: tokens?.expires_at ?? null,
      reauthorizationRequired: !tokens && Boolean(settings.account_user_id),
    },
    channel: settings.channel_id ? {
      id: settings.channel_id,
      deeplink: settings.channel_deeplink,
      name: settings.channel_name,
      number: settings.channel_number,
    } : null,
    scheduler: {
      enabled: Boolean(settings.scheduler_enabled),
      state: schedulerState,
      current: coordinator.current,
      queued: coordinator.queued,
      nextRunAt: scheduler.nextRunAt?.toISOString() ?? null,
      error: coordinator.lastError?.message ?? null,
    },
    lastRun: latest,
  };
}

export function runsView(database) {
  return database.recentRuns().map((row) => ({
    ...mapRun(row),
    details: database.runItems(row.id).map((item) => ({
      id: item.id,
      playId: item.play_id,
      outcome: item.outcome,
      matchMethod: item.match_method,
      airplayAt: item.airplay_at,
      artist: item.artist,
      title: item.title,
      errorCode: item.error_code,
      errorMessage: item.error_message,
    })),
  }));
}
