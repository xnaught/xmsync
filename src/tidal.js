import { CALLBACK_URL, COUNTRY_CODE, JSON_API, TIDAL_API_URL, TIDAL_AUTH_URL, TIDAL_RATE_LIMIT_FALLBACK_MS, TIDAL_REQUEST_INTERVAL_MS, TIDAL_SCOPES, TIDAL_TOKEN_URL, USER_AGENT } from './constants.js';
import { AppError } from './errors.js';
import { rankCandidates } from './matching.js';
import { fetchWithRetry, responseJson } from './request.js';
import { nowIso, parseRetryAfter, pkceChallenge, randomUrlToken, sleep } from './util.js';

function errorMessage(body, fallback) {
  return body?.errors?.map((error) => error.detail ?? error.title ?? error.code).filter(Boolean).join('; ') || body?.error_description || body?.error || fallback;
}

function parseScopes(value) {
  if (Array.isArray(value)) return value;
  return String(value ?? '').split(/\s+/).filter(Boolean);
}

function includedMap(body) {
  return new Map((body?.included ?? []).map((item) => [`${item.type}:${item.id}`, item]));
}

function relationshipResources(resource, name, included) {
  const linkage = resource?.relationships?.[name]?.data;
  const identifiers = Array.isArray(linkage) ? linkage : linkage ? [linkage] : [];
  return identifiers.map((item) => included.get(`${item.type}:${item.id}`)).filter(Boolean);
}

function candidateFromResource(resource, included) {
  const artists = relationshipResources(resource, 'artists', included).map((artist) => artist.attributes?.name).filter(Boolean);
  const albums = relationshipResources(resource, 'albums', included);
  return {
    id: resource.id,
    title: resource.attributes?.title ?? '',
    version: resource.attributes?.version ?? '',
    artists,
    album: albums[0]?.attributes?.title ?? '',
    albumType: albums[0]?.attributes?.type ?? albums[0]?.attributes?.albumType ?? '',
  };
}

export function permitsStreaming(body) {
  const rules = (body?.included ?? []).filter((item) => item.type === 'usageRules');
  return rules.some((rule) => ['free', 'paid', 'subscription'].some((key) =>
    Array.isArray(rule.attributes?.[key]) && rule.attributes[key].includes('STREAM')));
}

export class TidalClient {
  constructor(database, options = {}) {
    this.database = database;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiUrl = options.apiUrl ?? TIDAL_API_URL;
    this.authUrl = options.authUrl ?? TIDAL_AUTH_URL;
    this.tokenUrl = options.tokenUrl ?? TIDAL_TOKEN_URL;
    this.requestIntervalMs = options.requestIntervalMs ?? TIDAL_REQUEST_INTERVAL_MS;
    this.sleepImpl = options.sleepImpl ?? sleep;
    this.now = options.now ?? Date.now;
    this.nextRequestAt = 0;
    this.blockedUntil = 0;
    this.refreshPromise = null;
  }

  async paceRequest() {
    const now = this.now();
    if (now < this.blockedUntil) {
      throw new AppError('TIDAL_RATE_LIMITED', 'TIDAL asked the app to wait before sending more requests. Retry later.', {
        status: 429,
        retryable: true,
      });
    }
    const requestAt = Math.max(now, this.nextRequestAt);
    this.nextRequestAt = requestAt + this.requestIntervalMs;
    if (requestAt > now) await this.sleepImpl(requestAt - now);
  }

  authorizationUrl() {
    const settings = this.database.settings();
    if (!settings.tidal_client_id || !settings.tidal_client_secret) {
      throw new AppError('TIDAL_NOT_CONFIGURED', 'Save TIDAL developer credentials first.', { status: 400 });
    }
    const state = randomUrlToken();
    const verifier = randomUrlToken(64);
    const createdAt = nowIso();
    this.database.savePendingOAuth(state, verifier, createdAt);
    const url = new URL(this.authUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', settings.tidal_client_id);
    url.searchParams.set('redirect_uri', CALLBACK_URL);
    url.searchParams.set('scope', TIDAL_SCOPES.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', pkceChallenge(verifier));
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  async tokenRequest(form) {
    const settings = this.database.settings();
    const body = new URLSearchParams({ ...form, client_id: settings.tidal_client_id });
    const response = await fetchWithRetry(this.tokenUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${settings.tidal_client_id}:${settings.tidal_client_secret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
      body,
    }, { fetchImpl: this.fetchImpl, attempts: 2 });
    const payload = await responseJson(response, 'TIDAL');
    if (!response.ok) throw new AppError('TIDAL_TOKEN_FAILED', errorMessage(payload, 'TIDAL rejected the token request.'), {
      status: response.status,
      authRequired: ![429, 500, 502, 503, 504].includes(response.status),
      retryable: response.status === 429 || response.status >= 500,
    });
    return payload;
  }

  async completeAuthorization(query) {
    if (query.error) throw new AppError('TIDAL_AUTH_DENIED', query.error_description ?? 'TIDAL authorization was denied.', { status: 400 });
    if (!query.state || !query.code) throw new AppError('TIDAL_AUTH_INVALID', 'The TIDAL callback is missing state or code.', { status: 400 });
    const pending = this.database.consumePendingOAuth(query.state);
    if (!pending || Date.now() - Date.parse(pending.created_at) > 10 * 60_000) {
      throw new AppError('TIDAL_AUTH_STATE', 'The TIDAL authorization attempt is invalid or expired.', { status: 400 });
    }
    const payload = await this.tokenRequest({
      grant_type: 'authorization_code',
      code: query.code,
      redirect_uri: CALLBACK_URL,
      code_verifier: pending.verifier,
    });
    const scopes = parseScopes(payload.scope);
    const missing = TIDAL_SCOPES.filter((scope) => !scopes.includes(scope));
    if (missing.length) throw new AppError('TIDAL_MISSING_SCOPES', `TIDAL did not grant required scopes: ${missing.join(', ')}.`, { status: 403 });
    const user = await this.request('/users/me', { accessToken: payload.access_token, retryAuth: false });
    const userId = user?.data?.id;
    if (!userId) throw new AppError('TIDAL_USER_MISSING', 'TIDAL did not return the authenticated user identity.');
    const expectedUser = this.database.settings().account_user_id;
    if (expectedUser && expectedUser !== userId) {
      throw new AppError('TIDAL_ACCOUNT_MISMATCH', 'This database belongs to a different TIDAL account. Reconnect the original account or delete the local data directory.', { status: 409 });
    }
    this.database.saveTokens({
      userId,
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token ?? null,
      tokenType: payload.token_type ?? 'Bearer',
      scopes,
      expiresAt: new Date(Date.now() + Number(payload.expires_in ?? 3600) * 1000).toISOString(),
      updatedAt: nowIso(),
    });
    return userId;
  }

  async refresh() {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      const old = this.database.tokens();
      if (!old?.refresh_token) {
        this.database.clearTokens();
        throw new AppError('TIDAL_REAUTH_REQUIRED', 'TIDAL reauthorization required.', { authRequired: true });
      }
      try {
        const payload = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: old.refresh_token });
        const scopes = parseScopes(payload.scope || old.scopes);
        const missing = TIDAL_SCOPES.filter((scope) => !scopes.includes(scope));
        if (missing.length) throw new AppError('TIDAL_MISSING_SCOPES', `TIDAL refresh lost required scopes: ${missing.join(', ')}.`, { status: 403, authRequired: true });
        this.database.saveTokens({
          userId: old.user_id,
          accessToken: payload.access_token,
          refreshToken: payload.refresh_token ?? old.refresh_token,
          tokenType: payload.token_type ?? old.token_type,
          scopes,
          expiresAt: new Date(Date.now() + Number(payload.expires_in ?? 3600) * 1000).toISOString(),
          updatedAt: nowIso(),
        });
        return payload.access_token;
      } catch (error) {
        if (error.authRequired && !error.retryable) this.database.clearTokens();
        if (error.retryable) throw error;
        throw new AppError('TIDAL_REAUTH_REQUIRED', 'TIDAL reauthorization required.', { cause: error, authRequired: true });
      }
    })().finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  async accessToken() {
    const tokens = this.database.tokens();
    if (!tokens) throw new AppError('TIDAL_REAUTH_REQUIRED', 'Connect TIDAL before syncing.', { authRequired: true });
    if (Date.parse(tokens.expires_at) <= Date.now() + 60_000) return this.refresh();
    return tokens.access_token;
  }

  async request(pathOrUrl, options = {}) {
    const url = pathOrUrl.startsWith('http') ? new URL(pathOrUrl) : new URL(`${this.apiUrl}${pathOrUrl}`);
    if (url.origin !== new URL(this.apiUrl).origin) throw new AppError('TIDAL_INVALID_LINK', 'TIDAL returned an off-host pagination URL.');
    const token = options.accessToken ?? await this.accessToken();
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: JSON_API,
      'User-Agent': USER_AGENT,
      ...options.headers,
    };
    if (options.body) headers['Content-Type'] = JSON_API;
    let response;
    try {
      response = await fetchWithRetry(url, { method: options.method ?? 'GET', headers, body: options.body }, {
        fetchImpl: this.fetchImpl,
        sleepImpl: this.sleepImpl,
        beforeAttempt: () => this.paceRequest(),
        attempts: options.mutation ? 1 : 3,
      });
    } catch (error) {
      if (options.mutation && error instanceof AppError) error.unsafeWrite = true;
      throw error;
    }
    if (response.status === 429) {
      const now = this.now();
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'), now) ?? TIDAL_RATE_LIMIT_FALLBACK_MS;
      this.blockedUntil = Math.max(this.blockedUntil, now + retryAfter);
    }
    let body;
    try {
      body = await responseJson(response, 'TIDAL');
    } catch (error) {
      if (!response.ok) body = null;
      else {
        if (options.mutation && error instanceof AppError) error.unsafeWrite = true;
        throw error;
      }
    }
    if (response.status === 401 && !options.mutation && options.retryAuth !== false && !options.accessToken) {
      await this.refresh();
      return this.request(pathOrUrl, { ...options, retryAuth: false });
    }
    if (!response.ok) {
      const authRequired = response.status === 401;
      if (authRequired && options.retryAuth === false && !options.accessToken) this.database.clearTokens();
      throw new AppError(authRequired ? 'TIDAL_REAUTH_REQUIRED' : response.status === 403 ? 'TIDAL_FORBIDDEN' : 'TIDAL_REQUEST_FAILED',
        errorMessage(body, `TIDAL returned HTTP ${response.status}.`), {
          status: response.status,
          retryable: response.status === 429 || response.status >= 500,
          authRequired,
          unsafeWrite: options.mutation,
        });
    }
    if (options.mutation && (!body || typeof body !== 'object')) {
      throw new AppError('TIDAL_INVALID_RESPONSE', 'TIDAL returned an empty mutation response.', { unsafeWrite: true });
    }
    return body;
  }

  async currentUser() {
    return (await this.request('/users/me')).data;
  }

  async validateTrack(id) {
    try {
      const body = await this.request(`/tracks/${encodeURIComponent(id)}?countryCode=${COUNTRY_CODE}&include=usageRules`);
      return body?.data?.id && permitsStreaming(body) ? body.data.id : null;
    } catch (error) {
      if (error.status === 404 || error.status === 400) return null;
      throw error;
    }
  }

  async searchTrack(source) {
    const query = `${source.title} ${source.artists.join(' ')}`.slice(0, 256);
    const params = new URLSearchParams({
      'filter[query]': query,
      explicitFilter: 'INCLUDE',
      countryCode: COUNTRY_CODE,
      include: 'tracks,tracks.artists,tracks.albums',
    });
    let body;
    try {
      body = await this.request(`/searchResults?${params}`);
    } catch (error) {
      if (error.status !== 400) throw error;
      params.set('include', 'tracks');
      body = await this.request(`/searchResults?${params}`);
    }
    const included = includedMap(body);
    const resultResource = body?.data?.[0];
    const initialOrder = resultResource?.relationships?.tracks?.data ?? [];
    let resources = initialOrder.map((item) => included.get(`${item.type}:${item.id}`)).filter(Boolean);
    if (!resources.length) resources = [...included.values()].filter((item) => item.type === 'tracks');
    if (!resources.length && resultResource?.id) {
      const relation = await this.request(`/searchResults/${encodeURIComponent(resultResource.id)}/relationships/tracks?countryCode=${COUNTRY_CODE}&include=tracks`);
      const relationIncluded = includedMap(relation);
      resources = (relation.data ?? []).map((item) => relationIncluded.get(`${item.type}:${item.id}`)).filter(Boolean);
      if (!resources.length) resources = [...relationIncluded.values()].filter((item) => item.type === 'tracks');
      for (const [key, value] of relationIncluded) included.set(key, value);
    }
    const hydrated = [];
    for (const resource of resources.slice(0, 20)) {
      let candidate = candidateFromResource(resource, included);
      if (!candidate.artists.length) {
        try {
          const detail = await this.request(`/tracks/${encodeURIComponent(resource.id)}?countryCode=${COUNTRY_CODE}&include=artists,albums`);
          candidate = candidateFromResource(detail.data, includedMap(detail));
        } catch (error) {
          if (!error.retryable) continue;
          throw error;
        }
      }
      hydrated.push(candidate);
    }
    return rankCandidates(source, hydrated)[0] ?? null;
  }

  async allOwnedPlaylists() {
    const playlists = [];
    let next = `/playlists?filter[owners.id]=me&include=owners`;
    while (next) {
      const body = await this.request(next);
      playlists.push(...(body.data ?? []));
      next = body.links?.next ?? null;
    }
    return playlists;
  }

  async getPlaylist(id) {
    return (await this.request(`/playlists/${encodeURIComponent(id)}?include=owners`)).data;
  }

  createPlaylist(name, description, idempotencyKey) {
    const payload = JSON.stringify({ data: { type: 'playlists', attributes: { name, description, accessType: 'UNLISTED' } } });
    return this.request('/playlists', { method: 'POST', body: payload, headers: { 'Idempotency-Key': idempotencyKey }, mutation: true });
  }

  addPlaylistItems(id, items, idempotencyKey) {
    const payload = JSON.stringify({ data: items.map((item) => ({ type: 'tracks', id: item.trackId })) });
    return this.request(`/playlists/${encodeURIComponent(id)}/relationships/items`, {
      method: 'POST', body: payload, headers: { 'Idempotency-Key': idempotencyKey }, mutation: true,
    });
  }

  async playlistItems(id) {
    const items = [];
    let next = `/playlists/${encodeURIComponent(id)}/relationships/items?countryCode=${COUNTRY_CODE}`;
    while (next) {
      const body = await this.request(next);
      items.push(...(body.data ?? []));
      next = body.links?.next ?? null;
    }
    return items;
  }

  deletePlaylist(id, idempotencyKey = randomUrlToken()) {
    return this.request(`/playlists/${encodeURIComponent(id)}`, {
      method: 'DELETE', headers: { 'Idempotency-Key': idempotencyKey }, mutation: true,
    });
  }
}
