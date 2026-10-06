import { getRedis } from '../storage/redis.js';

const TTL_SECONDS = 60 * 60 * 24 * 90;

function key(platform, clipId) {
  return `publish:${platform}:${clipId}`;
}

export class PublishStore {
  static async reserve(platform, clipId) {
    const redis = getRedis();
    if (!redis) throw new Error('Redis is required for publish idempotency');
    const value = JSON.stringify({ status: 'reserved', at: Date.now() });
    const result = await redis.set(key(platform, clipId), value, 'EX', TTL_SECONDS, 'NX');
    return result === 'OK';
  }

  static async get(platform, clipId) {
    const redis = getRedis();
    if (!redis) return null;
    const raw = await redis.get(key(platform, clipId));
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  static async complete(platform, clipId, result) {
    const redis = getRedis();
    if (!redis) throw new Error('Redis is required for publish idempotency');
    await redis.set(key(platform, clipId), JSON.stringify({
      status: 'complete',
      at: Date.now(),
      result,
    }), 'EX', TTL_SECONDS);
  }

  static async fail(platform, clipId, error) {
    const redis = getRedis();
    if (!redis) return;
    await redis.set(key(platform, clipId), JSON.stringify({
      status: 'failed',
      at: Date.now(),
      error: String(error?.message || error).slice(0, 1000),
    }), 'EX', 60 * 60);
  }

  static async release(platform, clipId) {
    const redis = getRedis();
    if (redis) await redis.del(key(platform, clipId));
  }
}
