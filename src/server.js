import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_URL, HOST, PORT } from './constants.js';
import { publicError, AppError } from './errors.js';
import { runTidalSmokeTest } from './feasibility.js';
import { runsView, settingsView, statusView } from './status.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(payload);
}

function redirect(response, location) {
  response.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  response.end();
}

async function jsonBody(request) {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    throw new AppError('JSON_REQUIRED', 'This route requires a JSON request body.', { status: 415 });
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 64 * 1024) throw new AppError('BODY_TOO_LARGE', 'The request body is too large.', { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError('INVALID_JSON', 'The request body is not valid JSON.', { status: 400 });
  }
}

function enforceSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin || ![`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`].includes(origin)) {
    throw new AppError('ORIGIN_REJECTED', 'Cross-origin requests are not allowed.', { status: 403 });
  }
}

async function serveStatic(pathname, response) {
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  const safe = normalize(requested).replace(/^(\.\.[/\\])+/, '');
  const path = join(PUBLIC_DIR, safe);
  if (!path.startsWith(PUBLIC_DIR)) return false;
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    response.writeHead(200, {
      'Content-Type': CONTENT_TYPES[extname(path)] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' https:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://login.tidal.com",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
    createReadStream(path).pipe(response);
    return true;
  } catch {
    return false;
  }
}

function requireSyncReady(database) {
  const settings = database.settings();
  if (!settings.channel_id) throw new AppError('CHANNEL_REQUIRED', 'Select a SiriusXM channel first.', { status: 400 });
  if (!settings.tidal_client_id || !settings.tidal_client_secret) throw new AppError('TIDAL_NOT_CONFIGURED', 'Save TIDAL developer credentials first.', { status: 400 });
  if (!database.tokens()) throw new AppError('TIDAL_REAUTH_REQUIRED', 'Connect TIDAL before syncing.', { status: 401, authRequired: true });
}

export function createHttpServer({ database, xm, tidal, coordinator, scheduler }) {
  return createServer(async (request, response) => {
    const url = new URL(request.url, APP_URL);
    try {
      if (request.method === 'GET' && url.pathname === '/api/status') {
        return sendJson(response, 200, statusView(database, coordinator, scheduler));
      }
      if (request.method === 'GET' && url.pathname === '/api/settings') {
        return sendJson(response, 200, settingsView(database));
      }
      if (request.method === 'PUT' && url.pathname === '/api/settings') {
        enforceSameOrigin(request);
        const body = await jsonBody(request);
        if (typeof body.clientId !== 'string' || !body.clientId.trim() || typeof body.clientSecret !== 'string' || !body.clientSecret.trim()) {
          throw new AppError('CREDENTIALS_REQUIRED', 'Both client ID and client secret are required.', { status: 400 });
        }
        scheduler.stop();
        database.saveCredentials(body.clientId.trim(), body.clientSecret.trim());
        database.clearTokens();
        return sendJson(response, 200, settingsView(database));
      }
      if (request.method === 'GET' && url.pathname === '/auth/tidal/start') {
        return redirect(response, tidal.authorizationUrl());
      }
      if (request.method === 'GET' && url.pathname === '/auth/tidal/callback') {
        try {
          await tidal.completeAuthorization(Object.fromEntries(url.searchParams));
          return redirect(response, '/?auth=connected');
        } catch (error) {
          const params = new URLSearchParams({ auth: 'error', code: error.code ?? 'TIDAL_AUTH_FAILED' });
          return redirect(response, `/?${params}`);
        }
      }
      if (request.method === 'POST' && url.pathname === '/api/tidal/disconnect') {
        enforceSameOrigin(request);
        scheduler.stop();
        database.clearTokens();
        return sendJson(response, 200, { disconnected: true });
      }
      if (request.method === 'POST' && url.pathname === '/api/tidal/smoke') {
        enforceSameOrigin(request);
        if (!database.tokens()) throw new AppError('TIDAL_REAUTH_REQUIRED', 'Connect TIDAL before running the feasibility test.', { status: 401 });
        return sendJson(response, 200, await runTidalSmokeTest(tidal));
      }
      if (request.method === 'GET' && url.pathname === '/api/channels') {
        return sendJson(response, 200, { channels: await xm.listChannels() });
      }
      if (request.method === 'PUT' && url.pathname === '/api/channel') {
        enforceSameOrigin(request);
        const body = await jsonBody(request);
        const channels = await xm.listChannels();
        const channel = channels.find((item) => item.id === body.id || item.deeplink === String(body.deeplink ?? '').toLowerCase());
        if (!channel) throw new AppError('CHANNEL_INVALID', 'Select a channel from the current xmplaylist list.', { status: 400 });
        const changed = database.settings().channel_id !== channel.id;
        database.saveChannel(channel);
        if (changed && database.tokens()) scheduler.channelChanged();
        else scheduler.arm();
        return sendJson(response, 200, { channel, syncRequested: changed && Boolean(database.tokens()) });
      }
      if (request.method === 'POST' && url.pathname === '/api/sync/start') {
        enforceSameOrigin(request);
        requireSyncReady(database);
        return sendJson(response, 202, scheduler.start());
      }
      if (request.method === 'POST' && url.pathname === '/api/sync/stop') {
        enforceSameOrigin(request);
        scheduler.stop();
        return sendJson(response, 200, { stopped: true });
      }
      if (request.method === 'POST' && url.pathname === '/api/sync/now') {
        enforceSameOrigin(request);
        requireSyncReady(database);
        return sendJson(response, 202, scheduler.syncNow());
      }
      if (request.method === 'GET' && url.pathname === '/api/runs') {
        return sendJson(response, 200, { runs: runsView(database) });
      }
      if (request.method === 'GET' || request.method === 'HEAD') {
        if (await serveStatic(url.pathname, response)) return;
      }
      sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Route not found.' } });
    } catch (error) {
      const visible = publicError(error);
      if ((error.status ?? 500) >= 500) console.error(`[${visible.code}] ${visible.message}`);
      sendJson(response, error.status ?? 500, { error: visible });
    }
  });
}

export function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
}
