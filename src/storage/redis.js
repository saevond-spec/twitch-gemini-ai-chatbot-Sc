const Redis = require('ioredis');

class LowUsageRedisClient {
  constructor(redisUrl, options = {}) {
    // ---------- CONFIGURATION ----------
    this.cacheTTL = options.cacheTTL || 3600; // Default 1 hour (keep it high to avoid misses!)
    this.batchInterval = options.batchInterval || 200;
    this.maxQueueSize = 50;
    
    // ---------- STRICT FREE-TIER SAFEGUARDS ----------
    this.MAX_COMMANDS = 450000; // Hard stop at 450k to leave buffer
    this.commandCount = 0;
    this.isOffline = false;      // If true, we stop talking to Redis completely
    this.monthReset = this.getNextResetDate();

    // ---------- STATE ----------
    this.localCache = new Map();
    this.pendingGets = new Map();
    this.writeQueue = new Map();
    this.flushTimer = null;

    // Client setup (same as before, but with shorter retries to save pings)
    this.client = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      retryStrategy: (times, err) => {
        if (err && err.message && err.message.includes('max requests limit')) {
          this.isOffline = true;
          this.client.disconnect();
          return null;
        }
        // Only retry once to save quota
        if (times > 1) return null; 
        return 50; 
      },
      lazyConnect: true,
    });

    this.client.on('connect', () => {
      // If we are offline due to quota, disconnect immediately to save commands
      if (this.isOffline) {
        console.warn('[REDIS] Offline mode active. Disconnecting to save quota.');
        this.client.disconnect();
        return;
      }
      console.info('[REDIS] Connected.');
    });

    this.client.on('error', (err) => {
      if (err.message && err.message.includes('max requests limit')) {
        this.isOffline = true;
        this.client.disconnect();
      }
    });

    // Start background writer
    this.flushTimer = setInterval(() => this.flushWrites(), this.batchInterval);
    // Check for month reset every hour
    this.resetCheckTimer = setInterval(() => this.checkMonthReset(), 3600000);
  }

  // ---------- HELPER: Get next reset date (1st of next month) ----------
  getNextResetDate() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
  }

  // ---------- CHECK MONTH RESET ----------
  checkMonthReset() {
    const now = Date.now();
    if (now >= this.monthReset) {
      console.log('[REDIS] New month detected. Resetting command counter and going online.');
      this.commandCount = 0;
      this.isOffline = false;
      this.monthReset = this.getNextResetDate();
      // Attempt to reconnect
      this.client.connect().catch(() => {});
    }
  }

  // ---------- INTERNAL: Command Tracker ----------
  _canSendCommand() {
    // 1. Check if we passed the monthly reset
    this.checkMonthReset();

    // 2. If offline, block ALL commands
    if (this.isOffline) {
      return false;
    }

    // 3. If we hit the hard limit, go offline and block
    if (this.commandCount >= this.MAX_COMMANDS) {
      console.error(`[REDIS] Hard limit (${this.MAX_COMMANDS}) reached. Going OFFLINE until next month.`);
      this.isOffline = true;
      this.client.disconnect();
      return false;
    }

    return true;
  }

  _trackCommand() {
    this.commandCount++;
    // Log every 50k commands so you know where you stand
    if (this.commandCount % 50000 === 0) {
      console.warn(`[REDIS] Command count: ${this.commandCount} / ${this.MAX_COMMANDS} (${(this.commandCount/this.MAX_COMMANDS*100).toFixed(1)}%)`);
    }
  }

  // ---------- GET (Offline = Cache Only) ----------
  async get(key, options = {}) {
    if (!key) return null;

    // 1. Always check local cache first (free!)
    const entry = this.localCache.get(key);
    if (entry && entry.expires > Date.now()) {
      return entry.value;
    }

    // 2. If we are offline, return null (we can't fetch fresh data)
    if (this.isOffline || !this._canSendCommand()) {
      console.warn(`[REDIS] Offline/Quota full. Returning NULL for "${key}" (cache stale or miss).`);
      return null;
    }

    // 3. Deduplication logic (same as before)
    if (this.pendingGets.has(key)) {
      return new Promise((resolve, reject) => {
        this.pendingGets.get(key).push({ resolve, reject });
      });
    }

    const pending = [];
    this.pendingGets.set(key, pending);

    try {
      // Track this command BEFORE sending it
      this._trackCommand();
      const result = await this.client.get(key);
      
      if (result !== null) {
        this.localCache.set(key, {
          value: result,
          expires: Date.now() + this.cacheTTL * 1000,
        });
      }

      for (const { resolve } of pending) resolve(result);
      return result;
    } catch (err) {
      if (err.message && err.message.includes('max requests limit')) {
        this.isOffline = true;
        this.client.disconnect();
      }
      for (const { reject } of pending) reject(err);
      return null;
    } finally {
      this.pendingGets.delete(key);
    }
  }

  // ---------- SET (Offline = Drop Writes) ----------
  async set(key, value, ttlSeconds = null) {
    if (!key) return false;

    // Always store in local cache (so your app stays functional with stale data)
    this.localCache.set(key, {
      value,
      expires: Date.now() + (ttlSeconds || this.cacheTTL) * 1000,
    });

    // If offline or quota full, silently drop the write to save commands
    if (!this._canSendCommand()) {
      console.warn(`[REDIS] Offline/Quota full. Dropping SET for "${key}" (cached locally only).`);
      return false;
    }

    // Queue the write (deduplicated)
    this.writeQueue.set(key, { value, ttl: ttlSeconds });

    if (this.writeQueue.size >= this.maxQueueSize) {
      await this.flushWrites();
    }
    return true;
  }

  // ---------- FLUSH WRITES (with Command Tracking) ----------
  async flushWrites() {
    if (this.writeQueue.size === 0) return;
    if (!this._canSendCommand()) {
      this.writeQueue.clear();
      return;
    }

    const entries = Array.from(this.writeQueue.entries());
    this.writeQueue.clear();

    try {
      const pipeline = this.client.pipeline();
      for (const [key, { value, ttl }] of entries) {
        if (ttl) {
          pipeline.setex(key, ttl, value);
        } else {
          pipeline.set(key, value);
        }
      }
      
      // Track the number of commands in the pipeline
      this._trackCommand(entries.length); // Increment by number of SET commands
      await pipeline.exec();
    } catch (err) {
      if (err.message && err.message.includes('max requests limit')) {
        this.isOffline = true;
        this.client.disconnect();
      }
    }
  }

  // ---------- DESTROY ----------
  async destroy() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.resetCheckTimer) clearInterval(this.resetCheckTimer);
    await this.flushWrites();
    await this.client.quit();
    this.localCache.clear();
  }
}

module.exports = { LowUsageRedisClient };
