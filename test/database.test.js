import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '../src/database.js';

test('database binds history to the first connected TIDAL user', () => {
  const database = new Database(':memory:');
  const token = {
    userId: 'user-1', accessToken: 'access', refreshToken: 'refresh', tokenType: 'Bearer',
    scopes: ['user.read'], expiresAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-11T00:00:00.000Z',
  };
  database.saveTokens(token);
  assert.equal(database.tokens().user_id, 'user-1');
  assert.throws(() => database.saveTokens({ ...token, userId: 'user-2' }), /does not own this database/);
  database.clearTokens();
  assert.equal(database.tokens(), undefined);
  assert.equal(database.settings().account_user_id, 'user-1');
  database.close();
});

test('plays deduplicate by play ID rather than track ID', () => {
  const database = new Database(':memory:');
  const common = {
    channelId: 'channel', timestamp: '2026-09-11T12:00:00.000Z', localDate: '2026-09-11',
    trackId: 'same-track', title: 'Song', artists: ['Artist'], tidalLink: '123',
  };
  assert.equal(database.insertPlay({ ...common, id: 'play-1' }, common.timestamp), true);
  assert.equal(database.insertPlay({ ...common, id: 'play-1' }, common.timestamp), false);
  assert.equal(database.insertPlay({ ...common, id: 'play-2' }, common.timestamp), true);
  assert.equal(database.processablePlays('channel', '2026-09-10T00:00:00.000Z').length, 2);
  database.close();
});
