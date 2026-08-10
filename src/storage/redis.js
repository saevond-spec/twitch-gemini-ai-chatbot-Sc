// ============================================================
// src/storage/redis.js – Quota‑safe Redis client (LowUsage)
// ============================================================
import Redis from 'ioredis';
import { config } from '../config/index.js';
import { createLogger } from '../logger/index.js';

const log = createLogger('REDIS');

// -----------------------------------------------------------------
// LowUsageRedisClient – wraps ioredis with aggressive quota savings
// -----------------------------------------------------------------
class LowUsageRedisClient {
  constructor(redisUrl, options = {}) {
    if (!redisUrl) {
      throw new Error('A Redis URL is required');
    }

    this.cacheTTL = options.cacheTTL ?? 3600;
    this.batchInterval = options.batchInterval ?? 5000;
    this.maxQueueSize = options.maxQueueSize ?? 50;
    this.maxCacheSize = options.maxCacheSize ?? 5000;

    /*
     * Local safety limit (stops before Upstash’s 500k).
     * Resets on each instance restart – but the offline mode
     * also triggers on real quota errors, so it’s still safe.
     */
    this.maxCommands = options.maxCommands ?? 400000;
    this.commandCount = 0;

    this.isOffline = false;
    this.quotaExceeded = false;
    this.destroyed = false;
    this.flushInProgress = false;

    this.localCache = new Map();
    this.pendingGets = new Map();
    this.writeQueue = new Map();

    this.client = new Redis(redisUrl, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 10000,

      retryStrategy: (times) => {
        if (
          this.destroyed ||
          this.isOffline ||
          this.quotaExceeded ||
          times > 1
        ) {
          return null;
        }
        return Math.min(times * 250, 1000);
      },

      reconnectOnError: (error) => {
        if (this._isQuotaError(error)) {
          this._enterOfflineMode(error);
          return false;
        }
        return false;
      },
    });

    this.client.on('ready', () => {
      if (this.isOffline || this.quotaExceeded) {
        this.client.disconnect(false);
        return;
      }
      log.info('Redis client ready');
    });

    this.client.on('close', () => log.warn('Redis connection closed'));
    this.client.on('reconnecting', (delay) => {
      if (!this.isOffline && !this.quotaExceeded) {
        log.warn(`Redis reconnecting in ${delay}ms`);
      }
    });

    this.client.on('error', (error) => {
      if (this._isQuotaError(error)) {
        this._enterOfflineMode(error);
        return;
      }
      log.error(`Redis error: ${error.message}`);
    });

    this.flushTimer = setInterval(() => {
      this.flushWrites().catch((error) => {
        log.error(`Background flush failed: ${error.message}`);
      });
    }, this.batchInterval);

    this.flushTimer.unref?.();
  }

  // ---------- Quota detection ----------
  _isQuotaError(error) {
    const message = String(error?.message || error || '').toLowerCase();
    return (
      message.includes('max requests limit exceeded') ||
      message.includes('max daily request limit exceeded')
    );
  }

  _enterOfflineMode(error) {
    if (this.quotaExceeded) return;
    this.quotaExceeded = true;
    this.isOffline = true;
    log.error(`Request quota exhausted – Redis disabled: ${error?.message || error}`);
    this.client.disconnect(false); // no QUIT command
  }

  // ---------- Command tracking ----------
  _canSendCommands(amount = 1) {
    if (this.destroyed || this.isOffline || this.quotaExceeded || amount < 1) {
      return false;
    }
    if (this.commandCount + amount > this.maxCommands) {
      this.isOffline = true;
      log.error(`Local safety limit of ${this.maxCommands} commands reached`);
      this.client.disconnect(false);
      return false;
    }
    return true;
  }

  _trackCommands(amount = 1) {
    this.commandCount += amount;
    const prevBucket = Math.floor((this.commandCount - amount) / 50000);
    const currBucket = Math.floor(this.commandCount / 50000);
    if (currBucket > prevBucket) {
      const pct = ((this.commandCount / this.maxCommands) * 100).toFixed(1);
      log.warn(`Estimated local usage: ${this.commandCount}/${this.maxCommands} (${pct}%)`);
    }
  }

  // ---------- Local cache ----------
  _setLocalCache(key, value, ttlSeconds = this.cacheTTL) {
    if (this.localCache.has(key)) this.localCache.delete(key);
    this.localCache.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
    while (this.localCache.size > this.maxCacheSize) {
      const oldest = this.localCache.keys().next().value;
      this.localCache.delete(oldest);
    }
  }

  _getLocalCache(key) {
    const entry = this.localCache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.localCache.delete(key);
      return undefined;
    }
    // LRU refresh
    this.localCache.delete(key);
    this.localCache.set(key, entry);
    return entry.value;
  }

  // ---------- Public API ----------
  async get(key) {
    if (!key) return null;
    const cached = this._getLocalCache(key);
    if (cached !== undefined) return cached;

    if (!this._canSendCommands(1)) return null;

    if (this.pendingGets.has(key)) {
      return this.pendingGets.get(key);
    }

    const request = this._getFromRedis(key);
    this.pendingGets.set(key, request);
    try {
      return await request;
    } finally {
      this.pendingGets.delete(key);
    }
  }

  async _getFromRedis(key) {
    try {
      this._trackCommands(1);
      const result = await this.client.get(key);
      this._setLocalCache(key, result, this.cacheTTL); // cache misses too
      return result;
    } catch (error) {
      if (this._isQuotaError(error)) this._enterOfflineMode(error);
      else log.error(`GET "${key}" failed: ${error.message}`);
      return null;
    }
  }

  async set(key, value, ttlSeconds = null) {
    if (!key) return false;
    const effectiveTTL = ttlSeconds ?? this.cacheTTL;
    this._setLocalCache(key, value, effectiveTTL);

    if (!this._canSendCommands(1)) return false;

    this.writeQueue.set(key, { value, ttl: ttlSeconds });
    if (this.writeQueue.size >= this.maxQueueSize) {
      await this.flushWrites();
    }
    return true;
  }

  async del(key) {
    if (!key) return false;
    this.localCache.delete(key);
    this.writeQueue.delete(key);

    if (!this._canSendCommands(1)) return false;

    try {
      this._trackCommands(1);
      await this.client.del(key);
      return true;
    } catch (error) {
      if (this._isQuotaError(error)) this._enterOfflineMode(error);
      else log.error(`DEL "${key}" failed: ${error.message}`);
      return false;
    }
  }

  async ping() {
    if (this.isOffline || this.quotaExceeded) return false;
    if (!this._canSendCommands(1)) return false;
    this._trackCommands(1);
    try {
      await this.client.ping();
      return true;
    } catch (error) {
      if (this._isQuotaError(error)) this._enterOfflineMode(error);
      return false;
    }
  }

  // ---------- Batch flush ----------
  async flushWrites() {
    if (this.destroyed || this.flushInProgress || this.writeQueue.size === 0) return false;

    const entries = Array.from(this.writeQueue.entries());
    if (!this._canSendCommands(entries.length)) return false;

    this.flushInProgress = true;
    // Remove only the entries we are about to flush
    for (const [key, queuedValue] of entries) {
      if (this.writeQueue.get(key) === queuedValue) {
        this.writeQueue.delete(key);
      }
    }

    try {
      const pipeline = this.client.pipeline();
      for (const [key, { value, ttl }] of entries) {
        if (ttl != null) pipeline.set(key, value, 'EX', ttl);
        else pipeline.set(key, value);
      }
      this._trackCommands(entries.length);

      const results = await pipeline.exec();
      const failed = [];
      results.forEach(([error], idx) => {
        if (error) failed.push([entries[idx], error]);
      });

      for (const [[key, data], error] of failed) {
        if (this._isQuotaError(error)) {
          this._enterOfflineMode(error);
          break;
        }
        if (!this.writeQueue.has(key)) {
          this.writeQueue.set(key, data);
        }
      }
      return failed.length === 0;
    } catch (error) {
      if (this._isQuotaError(error)) this._enterOfflineMode(error);
      else {
        log.error(`Pipeline failed: ${error.message}`);
        for (const [key, data] of entries) {
          if (!this.writeQueue.has(key)) this.writeQueue.set(key, data);
        }
      }
      return false;
    } finally {
      this.flushInProgress = false;
    }
  }

  // ---------- Health / status ----------
  getStatus() {
    return {
      ready: this.client.status === 'ready',
      offline: this.isOffline,
      quotaExceeded: this.quotaExceeded,
      estimatedCommands: this.commandCount,
      queuedWrites: this.writeQueue.size,
      cachedEntries: this.localCache.size,
    };
  }

  // ---------- Cleanup ----------
  async destroy() {
    clearInterval(this.flushTimer);
    if (!this.isOffline && !this.quotaExceeded) {
      await this.flushWrites();
    }
    this.destroyed = true;
    this.client.disconnect(false);
    this.localCache.clear();
    this.pendingGets.clear();
    this.writeQueue.clear();
  }
}

// -----------------------------------------------------------------
// Singleton client instance
// -----------------------------------------------------------------
let redisClient = null;

export async function connectRedis() {
  if (!config.redis.url) {
    log.warn('No REDIS_URL provided – using file storage fallback');
    return null;
  }

  if (!redisClient) {
    redisClient = new LowUsageRedisClient(config.redis.url, {
      cacheTTL: 3600,           // 1 hour – adjust as needed
      batchInterval: 5000,      // flush writes every 5s
      maxQueueSize: 50,         // flush early if queue grows
      maxCacheSize: 5000,       // keep at most 5k cached keys
      maxCommands: 400000,      // stop at 400k local (safe buffer)
    });

    // Perform an initial ping to verify connectivity
    try {
      const ok = await redisClient.ping();
      if (ok) {
        log.info('Connected to Redis (quota‑safe client)');
        log.info(`Status: ${JSON.stringify(redisClient.getStatus())}`);
      } else {
        log.warn('Redis ping failed – client may be offline');
      }
    } catch (err) {
      log.warn(`Initial ping error: ${err.message}`);
    }
  }

  return redisClient;
}

export function getRedis() {
  return redisClient;
}
