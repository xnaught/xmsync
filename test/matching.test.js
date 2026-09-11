import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeText, rankCandidates, scoreCandidate } from '../src/matching.js';

test('normalization handles Unicode punctuation, featuring syntax, and harmless punctuation', () => {
  assert.equal(normalizeText('Don’t Stop — feat. Stevie Nicks'), 'don t stop stevie nicks');
  assert.equal(normalizeText('Earth, Wind & Fire'), 'earth wind and fire');
});

test('ranking prefers primary artist and original album version', () => {
  const source = { title: 'Dreams', artists: ['Fleetwood Mac'] };
  const candidates = [
    { id: 'karaoke', title: 'Dreams (Karaoke Version)', artists: ['Tribute Stars'], album: 'Karaoke Hits' },
    { id: 'live', title: 'Dreams', version: 'Live', artists: ['Fleetwood Mac'], album: 'Live in Boston' },
    { id: 'original', title: 'Dreams', artists: ['Fleetwood Mac'], album: 'Rumours', albumType: 'ALBUM' },
  ];
  assert.equal(rankCandidates(source, candidates)[0].id, 'original');
  assert.ok(scoreCandidate(source, candidates[2]).score > scoreCandidate(source, candidates[1]).score);
});

test('TIDAL result order is the final tie breaker', () => {
  const source = { title: 'Same', artists: ['Artist'] };
  const candidates = [
    { id: 'first', title: 'Same', artists: ['Artist'] },
    { id: 'second', title: 'Same', artists: ['Artist'] },
  ];
  assert.equal(rankCandidates(source, candidates)[0].id, 'first');
});
