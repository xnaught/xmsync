import assert from 'node:assert/strict';
import test from 'node:test';
import { RunCoordinator, Scheduler } from '../src/scheduler.js';

test('run coordinator prevents overlap and queues at most one generic follow-up', async () => {
  const resolvers = [];
  const calls = [];
  const engine = { async run(trigger, channel) {
    calls.push(`${trigger}:${channel.id}`);
    await new Promise((resolve) => resolvers.push(resolve));
    return { error: null };
  } };
  const coordinator = new RunCoordinator(engine);
  coordinator.request('manual', { id: 'old' });
  coordinator.request('manual', { id: 'old' });
  coordinator.request('schedule', { id: 'old' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['manual:old']);
  resolvers.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['manual:old', 'manual:old']);
  resolvers.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(coordinator.active, false);
});

test('channel change replaces a queued old-channel follow-up', async () => {
  const resolvers = [];
  const calls = [];
  const engine = { async run(trigger, channel) {
    calls.push(`${trigger}:${channel.id}`);
    await new Promise((resolve) => resolvers.push(resolve));
    return { error: null };
  } };
  const coordinator = new RunCoordinator(engine);
  coordinator.request('schedule', { id: 'old' });
  coordinator.request('manual', { id: 'old' });
  coordinator.request('channel_change', { id: 'new' });
  await new Promise((resolve) => setImmediate(resolve));
  resolvers.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['schedule:old', 'channel_change:new']);
  resolvers.shift()();
  await new Promise((resolve) => setImmediate(resolve));
});

test('scheduler stays clock-aligned and rechecks a backward clock change', () => {
  let now = new Date('2026-09-11T10:12:00');
  let timerCallback;
  let requested = null;
  const state = {
    scheduler_enabled: 1, channel_id: 'channel', channel_deeplink: 'channel', channel_name: 'Channel', channel_number: '1',
  };
  const database = {
    settings: () => state,
    setSchedulerEnabled: (enabled) => { state.scheduler_enabled = enabled ? 1 : 0; },
    tokens: () => ({ access_token: 'token' }),
  };
  const coordinator = {
    active: false, closing: false, onIdle() {},
    request(trigger) { requested = trigger; return { queued: false }; },
    cancelQueued() {},
  };
  const scheduler = new Scheduler(database, coordinator, {
    clock: () => new Date(now),
    setTimer(callback) { timerCallback = callback; return { unref() {} }; },
    clearTimer() {},
  });
  scheduler.arm();
  assert.equal(scheduler.nextRunAt.getMinutes(), 30);

  now = new Date('2026-09-11T10:20:00');
  timerCallback();
  assert.equal(requested, null);
  assert.equal(scheduler.nextRunAt.getMinutes(), 30);

  now = new Date('2026-09-11T10:30:00');
  timerCallback();
  assert.equal(requested, 'schedule');
  scheduler.disarm();
  assert.equal(state.scheduler_enabled, 1);
});
