import { getRedis } from '../storage/redis.js';

const COMPLETE_TTL = 60 * 60 * 24 * 90;
const FAILURE_TTL = 60 * 60 * 24 * 7;
const LOCK_TTL = 60 * 15;

function resultKey(platform, clipId) {
  return `publish:${platform}:${clipId}`;
}

function lockKey(platform, clipId) {
  return `publish-lock:${platform}:${clipId}`;
}

function failureKey(platform, clipId) {
  return `publish-failure:${platform}:${clipId}`;
}

export class PublishStore {
  static async reserve(platform, clipId) {
    const redis = getRedis();
    if (!redis) throw new Error('Redis is required for publish idempotency');
    if (await redis.exists(resultKey(platform, clipId))) return false;
    const value = JSON.stringify({ at: Date.now() });
    const locked = await redis.set(lockKey(platform, clipId), value, 'EX', LOCK_TTL, 'NX');
    return locked === 'OK';
  }

  static async get(platform, clipId) {
    const redis = getRedis();
    if (!redis) return null;
    const raw = await redis.get(resultKey(platform, clipId));
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  static async complete(platform, clipId, result) {
    const redis = getRedis();
    if (!redis) throw new Error('Redis is required for publish idempotency');
    await redis.set(resultKey(platform, clipId), JSON.stringify({
      status: 'complete',
      at: Date.now(),
      result,
    }), 'EX', COMPLETE_TTL);
    await redis.del(lockKey(platform, clipId));
  }

  static async fail(platform, clipId, error) {
    const redis = getRedis();
    if (!redis) return;
    await redis.set(failureKey(platform, clipId), JSON.stringify({
      status: 'failed',
      at: Date.now(),
      error: String(error?.message || error).slice(0, 1000),
    }), 'EX', FAILURE_TTL);
    await redis.del(lockKey(platform, clipId));
  }
}
