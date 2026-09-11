import { nextHalfHour } from './util.js';

export class RunCoordinator {
  constructor(engine, options = {}) {
    this.engine = engine;
    this.active = false;
    this.current = null;
    this.queued = null;
    this.lastError = null;
    this.closing = false;
    this.idleWaiters = [];
    this.onIdle = options.onIdle ?? (() => {});
    this.onChange = options.onChange ?? (() => {});
  }

  request(trigger, channel) {
    if (this.closing) return { queued: false, rejected: true };
    const job = { trigger, channel: { ...channel } };
    if (this.active) {
      if (trigger === 'channel_change' || !this.queued) this.queued = job;
      this.onChange();
      return { queued: true };
    }
    void this.pump(job);
    return { queued: false };
  }

  async pump(first) {
    this.active = true;
    let job = first;
    while (job) {
      this.current = job;
      this.lastError = null;
      this.onChange();
      try {
        const result = await this.engine.run(job.trigger, job.channel);
        this.lastError = result.error ?? null;
      } catch (error) {
        this.lastError = error;
      }
      job = this.queued;
      this.queued = null;
    }
    this.current = null;
    this.active = false;
    this.onChange();
    this.onIdle();
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  cancelQueued(predicate) {
    if (this.queued && predicate(this.queued)) this.queued = null;
  }

  close() {
    this.closing = true;
    this.queued = null;
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
    const previousOnIdle = coordinator.onIdle;
    coordinator.onIdle = () => {
      previousOnIdle();
      this.arm();
    };
  }

  channelFromSettings() {
    const settings = this.database.settings();
    if (!settings.channel_id) return null;
    return {
      id: settings.channel_id,
      deeplink: settings.channel_deeplink,
      name: settings.channel_name,
      number: settings.channel_number,
    };
  }

  enabled() {
    return this.database.settings().scheduler_enabled === 1;
  }

  arm() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.nextRunAt = null;
    if (this.coordinator.closing || !this.enabled() || this.coordinator.active || !this.channelFromSettings()) return;
    const boundary = nextHalfHour(this.clock());
    this.nextRunAt = boundary;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.nextRunAt = null;
      if (this.clock() < boundary) {
        this.arm();
        return;
      }
      const channel = this.channelFromSettings();
      if (this.enabled() && channel) this.coordinator.request('schedule', channel);
    }, Math.max(0, boundary.getTime() - this.clock().getTime()));
    this.timer.unref?.();
  }

  start() {
    this.database.setSchedulerEnabled(true);
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.nextRunAt = null;
    return this.coordinator.request('start', this.channelFromSettings());
  }

  stop() {
    this.database.setSchedulerEnabled(false);
    this.coordinator.cancelQueued((job) => ['schedule', 'start', 'startup'].includes(job.trigger));
    this.disarm();
  }

  disarm() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.nextRunAt = null;
  }

  syncNow() {
    return this.coordinator.request('manual', this.channelFromSettings());
  }

  channelChanged() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.nextRunAt = null;
    return this.coordinator.request('channel_change', this.channelFromSettings());
  }

  resume() {
    const settings = this.database.settings();
    if (settings.scheduler_enabled && settings.channel_id && this.database.tokens()) {
      this.coordinator.request('startup', this.channelFromSettings());
    } else {
      this.arm();
    }
  }
}
