import assert from 'node:assert/strict';
import test from 'node:test';
import { localDateKey, nextHalfHour, playlistDescription, playlistName, redact, yesterdayMidnight } from '../src/util.js';

test('local date helpers use calendar boundaries', () => {
  const originalTimezone = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const now = new Date('2026-03-09T16:00:00Z');
    const yesterday = yesterdayMidnight(now);
    assert.equal(localDateKey(yesterday), '2026-03-08');
    assert.equal(yesterday.getHours(), 0);
    assert.equal(now.getTime() - yesterday.getTime(), 35 * 60 * 60 * 1000);
  } finally {
    process.env.TZ = originalTimezone;
  }
});

test('nextHalfHour returns the next clock boundary', () => {
  assert.equal(nextHalfHour(new Date('2026-09-11T10:12:34')).getTime(), new Date('2026-09-11T10:30:00').getTime());
  assert.equal(nextHalfHour(new Date('2026-09-11T10:30:00')).getTime(), new Date('2026-09-11T11:00:00').getTime());
  assert.equal(nextHalfHour(new Date('2026-09-11T10:59:59')).getTime(), new Date('2026-09-11T11:00:00').getTime());
});

test('playlist text follows the exact naming convention', () => {
  assert.equal(playlistName('The Spectrum', '2026-09-11'), 'The Spectrum - 2026-09-11');
  assert.equal(playlistDescription('The Spectrum', '2026-09-11'), 'SiriusXM plays from The Spectrum on 2026-09-11, synced from xmplaylist.com.');
});

test('redaction recursively removes credential and token fields', () => {
  assert.deepEqual(redact({ accessToken: 'secret', nested: { client_secret: 'secret', safe: 'value' } }), {
    accessToken: '[REDACTED]', nested: { client_secret: '[REDACTED]', safe: 'value' },
  });
});
