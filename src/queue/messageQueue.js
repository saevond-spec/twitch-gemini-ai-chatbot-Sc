import { createLogger } from '../logger/index.js';

const log = createLogger('MSG-QUEUE');

export class MessageQueue {
  constructor(twitchClient) {
    this.client = twitchClient;
    this.queue = new Map();
    this.processing = new Set();
    this.interval = null;
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
    this.interval = setInterval(() => this.process(), 500);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  enqueue(channel, message, { priority = 'normal' } = {}) {
    if (!this.queue.has(channel)) this.queue.set(channel, []);
    const messages = this.queue.get(channel);
    if (priority === 'high') messages.unshift(message);
    else messages.push(message);
    log.debug(`Message queued for ${channel} (priority: ${priority})`);
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
    const now = Date.now();
    this.refillGlobal(now);
    if (this.globalBucket.tokens <= 0) return;

    for (const [channel, messages] of this.queue) {
      if (this.globalBucket.tokens <= 0) break;
      if (this.processing.has(channel) || !messages.length) continue;

      const lastSent = this.lastSentAt.get(channel) || 0;
      if (now - lastSent < this.minChannelIntervalMs) continue;

      const msg = messages.shift();
      this.processing.add(channel);
      try {
        await this.client.say(channel, msg);
        this.globalBucket.tokens -= 1;
        this.lastSentAt.set(channel, Date.now());
        log.debug(`Sent queued message to ${channel}; global tokens remaining: ${this.globalBucket.tokens}`);
      } catch (err) {
        log.error(`Failed to send queued message to ${channel}`, err);
        messages.unshift(msg);
      } finally {
        this.processing.delete(channel);
      }
    }

    for (const [channel, messages] of this.queue) {
      if (!messages.length) this.queue.delete(channel);
    }
  }
}
