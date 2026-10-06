import { createLogger } from '../logger/index.js';

const log = createLogger('MSG-QUEUE');
const buckets = new Map();

function intEnv(name, fallback, min, max) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}

export class MessageQueue {
  constructor(twitchClient) {
    this.client = twitchClient;
    this.queue = new Map();
    this.processing = new Set();
    this.interval = null;
    this.maxPerChannel = intEnv('CHAT_QUEUE_MAX_PER_CHANNEL', 50, 5, 500);
    this.maxAgeMs = intEnv('CHAT_QUEUE_MAX_AGE_SECONDS', 120, 15, 1800) * 1000;
    this.start();
  }

  start() {
    if (this.interval) return;
    this.interval = setInterval(() => this.process().catch(err => log.error('Queue process failed', err)), 500);
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  enqueue(channel, message, { priority = false } = {}) {
    if (!channel || !message) return false;
    if (!this.queue.has(channel)) this.queue.set(channel, []);
    const items = this.queue.get(channel);
    const entry = { message: String(message).slice(0, 500), enqueuedAt: Date.now() };

    if (priority) items.unshift(entry);
    else items.push(entry);

    while (items.length > this.maxPerChannel) {
      const dropped = items.shift();
      log.warn(`Dropped stale queued chat message for ${channel} after queue cap (${this.maxPerChannel})`);
    }
    return true;
  }

  _dropExpired(messages, now) {
    let dropped = 0;
    while (messages.length && now - messages[0].enqueuedAt > this.maxAgeMs) {
      messages.shift();
      dropped++;
    }
    return dropped;
  }

  async process() {
    const now = Date.now();
    for (const [channel, messages] of this.queue) {
      const dropped = this._dropExpired(messages, now);
      if (dropped) log.warn(`Dropped ${dropped} expired queued message(s) for ${channel}`);
      if (this.processing.has(channel) || !messages.length) continue;
      if (!this.client?.connected) continue;

      let bucket = buckets.get(channel);
      if (!bucket) {
        bucket = { tokens: 18, lastRefill: now };
        buckets.set(channel, bucket);
      }
      const elapsed = now - bucket.lastRefill;
      const refill = Math.floor(elapsed / 30000) * 18;
      if (refill > 0) {
        bucket.tokens = Math.min(18, bucket.tokens + refill);
        bucket.lastRefill = now;
      }
      if (bucket.tokens <= 0) continue;

      const item = messages.shift();
      this.processing.add(channel);
      try {
        const sent = await this.client.say(channel, item.message);
        if (sent) bucket.tokens--;
        else if (Date.now() - item.enqueuedAt <= this.maxAgeMs) messages.unshift(item);
      } catch (err) {
        log.error(`Failed to send queued message to ${channel}`, err);
        if (Date.now() - item.enqueuedAt <= this.maxAgeMs) messages.unshift(item);
      } finally {
        this.processing.delete(channel);
      }
    }

    for (const [channel, messages] of this.queue) {
      if (!messages.length) this.queue.delete(channel);
    }
  }
}
