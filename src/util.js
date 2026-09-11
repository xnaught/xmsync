import { createHash, randomBytes } from 'node:crypto';

export function nowIso(clock = Date) {
  return new clock().toISOString();
}

export function localDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('Invalid date');
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function yesterdayMidnight(value = new Date()) {
  const date = new Date(value);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1);
}

export function nextHalfHour(value = new Date()) {
  const next = new Date(value);
  next.setSeconds(0, 0);
  if (next.getMinutes() < 30) next.setMinutes(30);
  else {
    next.setMinutes(0);
    next.setHours(next.getHours() + 1);
  }
  return next;
}

export function playlistName(channelName, date) {
  return `${channelName} - ${date}`;
}

export function playlistDescription(channelName, date) {
  return `SiriusXM plays from ${channelName} on ${date}, synced from xmplaylist.com.`;
}

export function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

export function randomUrlToken(bytes = 32) {
  return base64Url(randomBytes(bytes));
}

export function pkceChallenge(verifier) {
  return base64Url(createHash('sha256').update(verifier).digest());
}

export function stableHash(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function maskSecret(value) {
  if (!value) return null;
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}${'*'.repeat(Math.min(value.length - 8, 12))}${value.slice(-4)}`;
}

const SECRET_KEYS = /(?:secret|token|authorization|code_verifier|client_secret|access_token|refresh_token)/i;

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEYS.test(key) ? '[REDACTED]' : redact(item)]));
}

export function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

export function parseRetryAfter(value, now = Date.now()) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const instant = Date.parse(value);
  return Number.isNaN(instant) ? null : Math.max(0, instant - now);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
