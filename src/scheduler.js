import { randomUUID } from 'node:crypto';
import { failureScope, publicError } from './errors.js';
import { nextHalfHour } from './util.js';

const TRIGGER_PRIORITY = new Map([
  ['schedule', 0], ['startup', 1], ['start', 2], ['channel_added', 3], ['manual', 4],
]);

function publicJob(job) {
  return job ? {
    trigger: job.trigger,
    channel: { ...job.channel },
    sweepId: job.sweepId,
    position: job.position,
    total: job.total,
  } : null;
}

export class RunCoordinator {
  constructor(engine, options = {}) {
    this.engine = engine;
    this.active = false;
    this.current = null;
    this.queued = [];
    this.errors = new Map();
    this.accountError = null;
    this.lastSweep = null;
    this.closing = false;
    this.idleWaiters = [];
    this.onIdle = options.onIdle ?? (() => {});
    this.onChange = options.onChange ?? (() => {});
    this.clock = options.clock ?? (() => new Date());
    this.sweeps = new Map();
  }

  request(trigger, channel) {
    return this.requestSweep(trigger, channel ? [channel] : []);
  }

  requestSweep(trigger, channels) {
    const requested = channels.map((channel) => channel.id);
    const response = { requested, started: [], queued: [], coalesced: [] };
    if (this.closing || channels.length === 0) return response;
    const sweepId = randomUUID();
    const sweep = {
      id: sweepId, trigger, startedAt: this.clock().toISOString(), endedAt: null,
      requested: [...requested], completed: [], failed: [], pending: new Set(requested),
    };
    this.sweeps.set(sweepId, sweep);
    this.lastSweep = sweep;

    channels.forEach((channel, index) => {
      const existing = this.queued.find((job) => job.channel.id === channel.id);
      if (existing) {
        if ((TRIGGER_PRIORITY.get(trigger) ?? 0) > (TRIGGER_PRIORITY.get(existing.trigger) ?? 0)) existing.trigger = trigger;
        existing.sweepIds.add(sweepId);
        response.coalesced.push(channel.id);
        return;
      }
      const job = {
        trigger, channel: Object.freeze({ ...channel }), sweepId, sweepIds: new Set([sweepId]),
        position: index + 1, total: channels.length,
      };
      if (!this.active && this.queued.length === 0 && response.started.length === 0) {
        response.started.push(channel.id);
        void this.pump(job);
      } else {
        this.queued.push(job);
        response.queued.push(channel.id);
      }
    });
    this.onChange();
    return response;
  }

  finishSweeps(job, failed) {
    for (const sweepId of job.sweepIds) {
      const sweep = this.sweeps.get(sweepId);
      if (!sweep) continue;
      sweep.pending.delete(job.channel.id);
      (failed ? sweep.failed : sweep.completed).push(job.channel.id);
      if (sweep.pending.size === 0) {
        sweep.endedAt = this.clock().toISOString();
        this.sweeps.delete(sweepId);
      }
    }
  }

  publicLastSweep() {
    if (!this.lastSweep) return null;
    const sweep = this.lastSweep;
    const done = sweep.completed.length + sweep.failed.length;
    return {
      id: sweep.id, trigger: sweep.trigger, startedAt: sweep.startedAt, endedAt: sweep.endedAt,
      requested: [...sweep.requested], completed: [...sweep.completed], failed: [...sweep.failed],
      text: `${done} of ${sweep.requested.length} channels completed${sweep.failed.length ? `; ${sweep.failed.length} failed` : ''}`,
    };
  }

  async pump(first) {
    this.active = true;
    let job = first;
    let stopPump = false;
    while (job) {
      this.current = job;
      this.onChange();
      try {
        const result = await this.engine.run(job.trigger, job.channel);
        const error = result.error ?? null;
        const visible = error ? publicError(error) : null;
        if (error) this.errors.set(job.channel.id, { channelId: job.channel.id, ...visible });
        else this.errors.delete(job.channel.id);
        this.finishSweeps(job, Boolean(error));
        const scope = error ? failureScope(error) : null;
        if (scope === 'account') {
          this.accountError = visible;
          this.cancelQueued(() => true);
        } else if (scope === 'process') {
          stopPump = true;
          this.cancelQueued(() => true);
        } else if (!error) {
          this.accountError = null;
        }
      } catch (error) {
        this.errors.set(job.channel.id, { channelId: job.channel.id, code: 'INTERNAL_ERROR', message: 'The sync coordinator encountered an unexpected error.' });
        this.finishSweeps(job, true);
        stopPump = true;
        this.cancelQueued(() => true);
      }
      job = stopPump ? null : (this.queued.shift() ?? null);
    }
    this.current = null;
    this.active = false;
    this.onChange();
    this.onIdle();
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  queuedView() {
    return this.queued.map(publicJob);
  }

  currentView() {
    return publicJob(this.current);
  }

  cancelQueued(predicate) {
    const cancelled = this.queued.filter(predicate);
    this.queued = this.queued.filter((job) => !predicate(job));
    for (const job of cancelled) this.finishSweeps(job, true);
    if (cancelled.length) this.onChange();
    return cancelled;
  }

  close() {
    this.closing = true;
    this.cancelQueued(() => true);
    if (!this.active) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }
}

export class Scheduler {
  constructor(database, coordinator, options = {}) {
    this.database = database;
    this.coordinator = coordinator;
    this.clock = options.clock ?? (() => new Date());
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.timer = null;
    this.nextRunAt = null;
  }

  enabled() {
    return this.database.settings().scheduler_enabled === 1;
  }

  channels() {
    return this.database.selectedChannels();
  }

  arm() {
    this.disarm();
    if (this.coordinator.closing || !this.enabled() || this.channels().length === 0) return;
    const boundary = nextHalfHour(this.clock());
    this.nextRunAt = boundary;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.nextRunAt = null;
      if (this.clock() < boundary) return this.arm();
      const channels = this.channels();
      this.arm();
      if (this.enabled() && channels.length) this.coordinator.requestSweep('schedule', channels);
    }, Math.max(0, boundary.getTime() - this.clock().getTime()));
    this.timer.unref?.();
  }

  start() {
    this.database.setSchedulerEnabled(true);
    this.arm();
    return this.coordinator.requestSweep('start', this.channels());
  }

  stop() {
    this.database.setSchedulerEnabled(false);
    const cancelled = this.coordinator.cancelQueued((job) => ['schedule', 'start', 'startup'].includes(job.trigger));
    this.disarm();
    return { active: this.coordinator.currentView?.() ?? this.coordinator.current, cancelled: cancelled.map((job) => job.channel.id) };
  }

  disarm() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.nextRunAt = null;
  }

  syncNow() {
    return this.coordinator.requestSweep('manual', this.channels());
  }

  selectionChanged(added, removed, connected) {
    const removedIds = new Set(removed.map((channel) => channel.id));
    this.coordinator.cancelQueued((job) => removedIds.has(job.channel.id));
    this.arm();
    return connected && added.length ? this.coordinator.requestSweep('channel_added', added) : { requested: [], started: [], queued: [], coalesced: [] };
  }

  resume() {
    if (this.enabled() && this.channels().length && this.database.tokens()) {
      this.arm();
      return this.coordinator.requestSweep('startup', this.channels());
    }
    this.arm();
    return { requested: [], started: [], queued: [], coalesced: [] };
  }
}
