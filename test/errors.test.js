import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError, attributeService, failureScope, preferRunError, publicError } from '../src/errors.js';

test('service attribution preserves an existing origin and stays private', () => {
  const error = new AppError('FAILED', 'failed', { service: 'xmplaylist' });
  assert.equal(attributeService(error, 'tidal'), error);
  assert.equal(error.service, 'xmplaylist');
  assert.deepEqual(publicError(error), { code: 'FAILED', message: 'failed' });
});

test('failure scope requires explicit TIDAL attribution for account-wide failures', () => {
  assert.equal(failureScope(new AppError('XM_LIMIT', 'limited', { status: 429, service: 'xmplaylist' })), 'channel');
  assert.equal(failureScope(new AppError('TIDAL_LIMIT', 'limited', { status: 429, service: 'tidal' })), 'account');
  assert.equal(failureScope(new AppError('AUTH', 'reauthorize', { authRequired: true, service: 'tidal' })), 'account');
  assert.equal(failureScope(new Error('database failed')), 'process');
});

test('run errors prefer process, account, unsafe write, then channel failures', () => {
  const channel = new AppError('XM_FAILED', 'scan failed', { service: 'xmplaylist' });
  const unsafe = new AppError('AMBIGUOUS', 'write uncertain', { unsafeWrite: true });
  const account = new AppError('TIDAL_LIMIT', 'limited', { status: 429, service: 'tidal' });
  const process = new Error('database failed');
  assert.equal(preferRunError(channel, unsafe), unsafe);
  assert.equal(preferRunError(unsafe, account), account);
  assert.equal(preferRunError(account, channel), account);
  assert.equal(preferRunError(account, process), process);
});
