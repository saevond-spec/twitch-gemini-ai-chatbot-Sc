
import { createLogger } from '../logger/index.js';
const log = createLogger('MSG-QUEUE');
const buckets = new Map();
export class MessageQueue {
  constructor(twitchClient) {
    this.client = twitchClient;
    this.queue = new Map();
    this.processing = new Set();
    this.interval = null;
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
  enqueue(channel, message) {
    if (!this.queue.has(channel)) {
      this.queue.set(channel, []);
    }
    this.queue.get(channel).push(message);
    log.debug(`Message queued for ${channel}`);
  }
  async process() {
    const now = Date.now();
    for (const [channel, messages] of this.queue) {
      if (this.processing.has(channel)) continue;
      if (!messages.length) continue;
      let bucket = buckets.get(channel);
      if (!bucket) {
        bucket = { tokens: 20, lastRefill: now };
        buckets.set(channel, bucket);
      }
      const elapsed = now - bucket.lastRefill;
      const refill = Math.floor(elapsed / 30000) * 20;
      if (refill > 0) {
        bucket.tokens = Math.min(20, bucket.tokens + refill);
        bucket.lastRefill = now;
      }
      if (bucket.tokens <= 0) continue;
      const msg = messages.shift();
      this.processing.add(channel);
      try {
        await this.client.say(channel, msg);
        bucket.tokens--;
        log.debug(`Sent queued message to ${channel}, remaining tokens: ${bucket.tokens}`);
      } catch (err) {
        log.error(`Failed to send queued message to ${channel}`, err);
        messages.push(msg);
      } finally {
        this.processing.delete(channel);
      }
    }
    for (const [channel, messages] of this.queue) {
      if (!messages.length) {
        this.queue.delete(channel);
      }
    }
  }
}
