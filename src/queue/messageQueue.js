import { createLogger } from '../logger/index.js';

const log = createLogger('MSG-QUEUE');

export class MessageQueue {
  constructor(twitchClient, { pollIntervalMs = 500 } = {}) {
    this.client = twitchClient;
    this.queue = new Map();
    this.processing = new Set();
    this.interval = null;
    this.processPromise = null;
    this.processRequested = false;
    this.processImmediate = null;
    this.pollIntervalMs = Math.max(50, Number(pollIntervalMs) || 500);
    this.lastSentAt = new Map();
    this.minChannelIntervalMs = Math.max(1000, Number(process.env.TWITCH_MIN_SEND_INTERVAL_MS || 1100));
    this.globalBucket = {
      tokens: Math.max(1, Number(process.env.TWITCH_GLOBAL_MESSAGES_PER_30S || 20)),
      capacity: Math.max(1, Number(process.env.TWITCH_GLOBAL_MESSAGES_PER_30S || 20)),
      lastRefill: Date.now(),
    };
    this.start();
  }

  start() {
    this.interval = setInterval(() => this.process(), this.pollIntervalMs);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.processImmediate) {
      clearImmediate(this.processImmediate);
      this.processImmediate = null;
    }
  }

  enqueue(channel, message, { priority = 'normal', onDelivered = null } = {}) {
    if (!this.queue.has(channel)) this.queue.set(channel, []);
    const messages = this.queue.get(channel);
    const entry = {
      message,
      onDelivered: typeof onDelivered === 'function' ? onDelivered : null,
    };
    if (priority === 'high') messages.unshift(entry);
    else messages.push(entry);
    log.debug(`Message queued for ${channel} (priority: ${priority})`);

    if (priority === 'high' && !this.processImmediate) {
      this.processImmediate = setImmediate(() => {
        this.processImmediate = null;
        this.process().catch(err => log.error('Immediate queue processing failed', err));
      });
    }
  }

  refillGlobal(now) {
    const elapsed = now - this.globalBucket.lastRefill;
    const periods = Math.floor(elapsed / 30000);
    if (periods <= 0) return;
    this.globalBucket.tokens = Math.min(
      this.globalBucket.capacity,
      this.globalBucket.tokens + periods * this.globalBucket.capacity
    );
    this.globalBucket.lastRefill += periods * 30000;
  }

  async process() {
    if (this.processPromise) {
      this.processRequested = true;
      return this.processPromise;
    }

    this.processPromise = this._processQueue();
    try {
      await this.processPromise;
    } finally {
      this.processPromise = null;
      if (this.processRequested) {
        this.processRequested = false;
        await this.process();
      }
    }
  }

  async _processQueue() {
    const now = Date.now();
    this.refillGlobal(now);
    if (this.globalBucket.tokens <= 0) return;

    for (const [channel, messages] of this.queue) {
      if (this.globalBucket.tokens <= 0) break;
      if (this.processing.has(channel) || !messages.length) continue;

      const lastSent = this.lastSentAt.get(channel) || 0;
      if (now - lastSent < this.minChannelIntervalMs) continue;

      const entry = messages.shift();
      const msg = typeof entry === 'string' ? entry : entry.message;
      this.processing.add(channel);
      try {
        const delivered = await this.client.say(channel, msg);
        if (delivered === false) {
          messages.unshift(entry);
          log.debug(`Delivery refused for ${channel}; message requeued`);
          continue;
        }
        this.globalBucket.tokens -= 1;
        this.lastSentAt.set(channel, Date.now());
        log.debug(`Sent queued message to ${channel}; global tokens remaining: ${this.globalBucket.tokens}`);
        if (typeof entry?.onDelivered === 'function') {
          try {
            await entry.onDelivered({ channel, message: msg });
          } catch (err) {
            log.warn(`Delivery callback failed for ${channel}`, err);
          }
        }
      } catch (err) {
        log.error(`Failed to send queued message to ${channel}`, err);
        messages.unshift(entry);
      } finally {
        this.processing.delete(channel);
      }
    }

    for (const [channel, messages] of this.queue) {
      if (!messages.length) this.queue.delete(channel);
    }
  }
}
