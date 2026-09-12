import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePlay, parseTidalLink, parseXmCursor, XmPlaylistClient } from '../src/xmplaylist.js';

test('TIDAL links accept only direct tidal.com track paths', () => {
  assert.equal(parseTidalLink([{ site: 'tidal', url: 'http://www.tidal.com/track/442544558' }]), '442544558');
  assert.equal(parseTidalLink([{ site: 'TIDAL', url: 'https://tidal.com/track/opaque-id/' }]), 'opaque-id');
  assert.equal(parseTidalLink([{ site: 'tidal', url: 'https://evil.example/track/1' }]), null);
  assert.equal(parseTidalLink([{ site: 'tidal', url: 'https://tidal.com/album/1?track=2' }]), null);
  assert.equal(parseTidalLink([{ site: 'tidal', url: 'https://tidal.com/track/1?x=2' }]), null);
});

test('xmplaylist cursor is extracted while arbitrary hosts and paths are rejected', () => {
  assert.equal(parseXmCursor('http://xmplaylist.com/api/station/thespectrum?last=1712536800000', 'thespectrum'), '1712536800000');
  assert.throws(() => parseXmCursor('https://evil.example/api/station/thespectrum?last=1', 'thespectrum'), { code: 'XM_INVALID_CURSOR' });
  assert.throws(() => parseXmCursor('https://xmplaylist.com/api/station/other?last=1', 'thespectrum'), { code: 'XM_INVALID_CURSOR' });
  assert.throws(() => parseXmCursor('https://xmplaylist.com/api/station/thespectrum?last=nope', 'thespectrum'), { code: 'XM_INVALID_CURSOR' });
  assert.throws(() => parseXmCursor(undefined, 'thespectrum'), { code: 'XM_INVALID_CURSOR' });
});

test('live-shaped plays normalize additive links and UTC time', () => {
  const play = normalizePlay({
    id: 'play-1',
    timestamp: '2026-09-11T20:28:24.483Z',
    track: { id: 'P7BA-IU9S', title: 'Mr Electric Blue', artists: ['Benson Boone'] },
    links: [{ site: 'tidal', url: 'http://www.tidal.com/track/442544558' }],
    futureField: true,
  }, 'station-1');
  assert.equal(play.id, 'play-1');
  assert.equal(play.tidalLink, '442544558');
  assert.equal(play.timestamp, '2026-09-11T20:28:24.483Z');
});

test('xmplaylist network, malformed-response, cursor, and rate-limit errors retain service attribution', async () => {
  const network = new XmPlaylistClient({ fetchImpl: async () => { throw new Error('offline'); }, sleepImpl: async () => {} });
  await assert.rejects(network.listChannels(), (error) => error.code === 'NETWORK_ERROR' && error.service === 'xmplaylist');

  const malformed = new XmPlaylistClient({ fetchImpl: async () => new Response('not json') });
  await assert.rejects(malformed.listChannels(), (error) => error.code === 'XMPLAYLIST_INVALID_RESPONSE' && error.service === 'xmplaylist');

  let calls = 0;
  const limited = new XmPlaylistClient({
    sleepImpl: async () => {},
    fetchImpl: async () => { calls += 1; return new Response('{}', { status: 429 }); },
  });
  await assert.rejects(limited.listChannels(), (error) => error.status === 429 && error.service === 'xmplaylist');
  assert.equal(calls, 3);
  assert.throws(() => parseXmCursor('https://evil.example/api/station/test?last=1', 'test'), { service: 'xmplaylist' });
});
