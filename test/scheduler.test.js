import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../src/errors.js';
import { RunCoordinator, Scheduler } from '../src/scheduler.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('run coordinator serializes a FIFO and coalesces one follow-up per channel', async () => {
  const resolvers = [];
  const calls = [];
  const engine = { async run(trigger, channel) {
    calls.push(`${trigger}:${channel.id}`);
    await new Promise((resolve) => resolvers.push(resolve));
    return { error: null };
  } };
  const coordinator = new RunCoordinator(engine);
  coordinator.requestSweep('schedule', [{ id: 'a' }, { id: 'b' }]);
  coordinator.requestSweep('manual', [{ id: 'a' }, { id: 'b' }]);
  assert.deepEqual(coordinator.queued.map((job) => `${job.trigger}:${job.channel.id}`), ['manual:b', 'manual:a']);
  resolvers.shift()(); await tick();
  assert.deepEqual(calls, ['schedule:a', 'manual:b']);
  resolvers.shift()(); await tick();
  assert.deepEqual(calls, ['schedule:a', 'manual:b', 'manual:a']);
  resolvers.shift()(); await tick();
  assert.equal(coordinator.active, false);
});

test('channel-local errors continue while authorization loss drops later jobs', async () => {
  const calls = [];
  const engine = { async run(trigger, channel) {
    calls.push(channel.id);
    if (channel.id === 'a') return { error: new AppError('LOCAL', 'local failure') };
    if (channel.id === 'b') return { error: new AppError('AUTH', 'reconnect', { authRequired: true, service: 'tidal' }) };
    return { error: null };
  } };
  const coordinator = new RunCoordinator(engine);
  coordinator.requestSweep('manual', [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  await tick(); await tick();
  assert.deepEqual(calls, ['a', 'b']);
  assert.equal(coordinator.errors.has('a'), true);
  assert.equal(coordinator.accountError.code, 'AUTH');
});

test('identical rate limits are channel-local for xmplaylist and account-wide for TIDAL', async () => {
  const calls = [];
  const errors = [
    new AppError('XM_REQUEST_FAILED', 'limited', { status: 429, service: 'xmplaylist' }),
    new AppError('TIDAL_REQUEST_FAILED', 'limited', { status: 429, service: 'tidal' }),
  ];
  const engine = { async run(trigger, channel) {
    calls.push(channel.id);
    return { error: errors.shift() ?? null };
  } };
  const coordinator = new RunCoordinator(engine);
  coordinator.requestSweep('manual', [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  await tick(); await tick();
  assert.deepEqual(calls, ['a', 'b']);
  assert.equal(coordinator.errors.get('a').code, 'XM_REQUEST_FAILED');
  assert.equal(coordinator.accountError.code, 'TIDAL_REQUEST_FAILED');
});

test('unexpected returned errors stop the pump and clear queued jobs', async () => {
  const calls = [];
  const engine = { async run(trigger, channel) {
    calls.push(channel.id);
    return { error: new Error('database failed') };
  } };
  const coordinator = new RunCoordinator(engine);
  coordinator.requestSweep('manual', [{ id: 'a' }, { id: 'b' }]);
  await tick(); await tick();
  assert.deepEqual(calls, ['a']);
  assert.equal(coordinator.queued.length, 0);
});

test('scheduler stays armed during work and rechecks a backward clock change', () => {
  let now = new Date('2026-09-11T10:12:00');
  let timerCallback;
  const requested = [];
  const state = { scheduler_enabled: 1 };
  const selected = [{ id: 'a' }, { id: 'b' }];
  const database = {
    settings: () => state,
    selectedChannels: () => selected,
    setSchedulerEnabled: (enabled) => { state.scheduler_enabled = enabled ? 1 : 0; },
    tokens: () => ({ access_token: 'token' }),
  };
  const coordinator = {
    active: true, closing: false,
    requestSweep(trigger, channels) { requested.push([trigger, channels.map((channel) => channel.id)]); return {}; },
    cancelQueued() { return []; }, currentView() { return null; },
  };
  const scheduler = new Scheduler(database, coordinator, {
    clock: () => new Date(now),
    setTimer(callback) { timerCallback = callback; return { unref() {} }; },
    clearTimer() {},
  });
  scheduler.arm();
  assert.equal(scheduler.nextRunAt.getMinutes(), 30);
  now = new Date('2026-09-11T10:20:00'); timerCallback();
  assert.equal(requested.length, 0);
  now = new Date('2026-09-11T10:30:00'); timerCallback();
  assert.deepEqual(requested, [['schedule', ['a', 'b']]]);
  assert.equal(scheduler.nextRunAt.getMinutes(), 0);
});
