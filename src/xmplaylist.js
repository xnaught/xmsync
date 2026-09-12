import { XMPLAYLIST_URL, USER_AGENT } from './constants.js';
import { AppError } from './errors.js';
import { fetchWithRetry, responseJson } from './request.js';
import { localDateKey } from './util.js';

export function parseXmCursor(next, expectedChannel) {
  if (next === null) return null;
  if (next === undefined) throw new AppError('XM_INVALID_CURSOR', 'xmplaylist omitted its pagination state.', { service: 'xmplaylist' });
  let url;
  try {
    url = new URL(next);
  } catch {
    throw new AppError('XM_INVALID_CURSOR', 'xmplaylist returned a malformed pagination URL.', { service: 'xmplaylist' });
  }
  if (url.hostname.toLowerCase() !== 'xmplaylist.com' || !['http:', 'https:'].includes(url.protocol)) {
    throw new AppError('XM_INVALID_CURSOR', 'xmplaylist returned an off-host pagination URL.', { service: 'xmplaylist' });
  }
  const expectedPath = `/api/station/${expectedChannel.toLowerCase()}`;
  if (url.pathname.toLowerCase() !== expectedPath) {
    throw new AppError('XM_INVALID_CURSOR', 'xmplaylist returned a pagination URL for another channel.', { service: 'xmplaylist' });
  }
  const last = url.searchParams.get('last');
  if (!last || !/^\d+$/.test(last)) {
    throw new AppError('XM_INVALID_CURSOR', 'xmplaylist returned a pagination URL without a valid cursor.', { service: 'xmplaylist' });
  }
  return last;
}

export function parseTidalLink(links) {
  const link = Array.isArray(links) ? links.find((item) => item?.site?.toLowerCase() === 'tidal') : null;
  if (!link?.url) return null;
  try {
    const url = new URL(link.url);
    const host = url.hostname.toLowerCase();
    if (!['tidal.com', 'www.tidal.com'].includes(host) || !['http:', 'https:'].includes(url.protocol)) return null;
    if (url.search || url.hash) return null;
    const match = url.pathname.match(/^\/track\/([^/]+)\/?$/);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

export function normalizePlay(raw, channelId) {
  if (!raw || typeof raw.id !== 'string' || !raw.id || typeof raw.timestamp !== 'string' ||
      !raw.track || typeof raw.track.id !== 'string' || !raw.track.id || typeof raw.track.title !== 'string' ||
      !Array.isArray(raw.track.artists) || raw.track.artists.some((artist) => typeof artist !== 'string')) {
    throw new AppError('XM_MALFORMED_PLAY', 'xmplaylist returned a play with missing identity or track metadata.', { service: 'xmplaylist' });
  }
  const instant = new Date(raw.timestamp);
  if (Number.isNaN(instant.getTime())) throw new AppError('XM_MALFORMED_PLAY', 'xmplaylist returned an invalid airplay timestamp.', { service: 'xmplaylist' });
  return {
    id: raw.id,
    channelId,
    timestamp: instant.toISOString(),
    localDate: localDateKey(instant),
    trackId: raw.track.id,
    title: raw.track.title,
    artists: raw.track.artists,
    tidalLink: parseTidalLink(raw.links),
  };
}

export class XmPlaylistClient {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? XMPLAYLIST_URL;
    this.sleepImpl = options.sleepImpl;
    this.requestTimeoutMs = options.requestTimeoutMs;
  }

  async request(path) {
    const response = await fetchWithRetry(`${this.baseUrl}${path}`, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    }, { fetchImpl: this.fetchImpl, sleepImpl: this.sleepImpl, timeoutMs: this.requestTimeoutMs, service: 'xmplaylist' });
    const body = await responseJson(response, 'XMPLAYLIST');
    if (!response.ok) {
      throw new AppError('XM_REQUEST_FAILED', body?.message ?? `xmplaylist returned HTTP ${response.status}.`, {
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
        service: 'xmplaylist',
      });
    }
    return body;
  }

  async listChannels() {
    const body = await this.request('/station');
    if (!Array.isArray(body?.results)) throw new AppError('XM_INVALID_RESPONSE', 'xmplaylist returned an invalid station list.', { service: 'xmplaylist' });
    return body.results
      .filter((item) => item && typeof item.id === 'string' && typeof item.name === 'string' && typeof item.deeplink === 'string')
      .map((item) => ({ id: item.id, name: item.name, number: String(item.number ?? ''), deeplink: item.deeplink.toLowerCase() }))
      .sort((left, right) => Number(left.number) - Number(right.number) || left.name.localeCompare(right.name));
  }

  async page(channelDeeplink, cursor = null) {
    const path = `/station/${encodeURIComponent(channelDeeplink.toLowerCase())}${cursor ? `?last=${encodeURIComponent(cursor)}` : ''}`;
    const body = await this.request(path);
    if (!Array.isArray(body?.results)) throw new AppError('XM_INVALID_RESPONSE', 'xmplaylist returned an invalid play page.', { service: 'xmplaylist' });
    return body;
  }
}
