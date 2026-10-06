
import Redis from 'ioredis';
import { config } from '../config/index.js';
import { createLogger } from '../logger/index.js';
const log = createLogger('REDIS');
let redis = null;
export async function connectRedis() {
  if (!config.redis.url) {
    log.warn('No REDIS_URL provided, using file storage fallback');
    return null;
  }
  redis = new Redis(config.redis.url, {
    retryStrategy(times) {
      const delay = Math.min(times * 50, 2000);
      log.warn(`Redis reconnect attempt ${times}, delay ${delay}ms`);
      return delay;
    },
    maxRetriesPerRequest: 3,
  });
  redis.on('connect', () => log.info('Connected to Redis'));
  redis.on('error', (err) => log.error('Redis error', err));
  redis.on('close', () => log.warn('Redis connection closed'));
  await redis.ping();
  return redis;
}
export function getRedis() { return redis; }
