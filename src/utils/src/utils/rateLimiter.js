// src/utils/rateLimiter.js
export class RateLimiter {
  constructor(maxTokens, refillInterval) {
    this.maxTokens = maxTokens;
    this.refillInterval = refillInterval;
    this.tokens = new Map();
  }

  async wait(channel) {
    const key = channel.toLowerCase();
    const now = Date.now();
    let bucket = this.tokens.get(key);
    if (!bucket) {
      bucket = { tokens: this.maxTokens, lastRefill: now };
      this.tokens.set(key, bucket);
    }
    const elapsed = now - bucket.lastRefill;
    const refillAmount = Math.floor(elapsed / this.refillInterval) * this.maxTokens;
    if (refillAmount > 0) {
      bucket.tokens = Math.min(this.maxTokens, bucket.tokens + refillAmount);
      bucket.lastRefill = now;
    }
    if (bucket.tokens <= 0) {
      const waitTime = this.refillInterval - (now - bucket.lastRefill);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      bucket.tokens = this.maxTokens;
      bucket.lastRefill = Date.now();
    }
    bucket.tokens -= 1;
  }
}
