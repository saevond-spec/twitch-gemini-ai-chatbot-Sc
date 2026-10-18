import { getRedis } from '../storage/redis.js';

const STATS_TTL_SECONDS = 180 * 24 * 60 * 60;
const ATTRIBUTION_TTL_SECONDS = 10 * 60;
const DEFAULT_REPLY_WINDOW_MS = 120_000;

const memoryStats = new Map();
const memoryAttributions = new Map();

function parse(raw, fallback = null) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

function statDefaults(data = null) {
  const impressions = Math.max(0, Number(data?.impressions || 0));
  const replies = Math.max(0, Math.min(impressions, Number(data?.replies || 0)));
  return {
    impressions,
    replies,
    alpha: 1 + replies,
    beta: 4 + impressions - replies,
  };
}

function attributionKey(channel, viewer) {
  return `${String(channel || '').toLowerCase()}:${String(viewer || '').toLowerCase()}`;
}

export class RetentionStore {
  static async getStrategyStats(strategy) {
    const redis = getRedis();
    let data;
    if (redis) data = parse(await redis.get(`retention:strategy:${strategy}`), null);
    else data = memoryStats.get(strategy) || null;
    return statDefaults(data);
  }

  static async recordImpression({
    channel,
    viewer,
    strategy,
    at = Date.now(),
    replyWindowMs = DEFAULT_REPLY_WINDOW_MS,
  }) {
    const current = await this.getStrategyStats(strategy);
    const next = {
      impressions: current.impressions + 1,
      replies: current.replies,
    };
    const attribution = {
      strategy,
      at,
      replyWindowMs,
      responded: false,
    };

    const redis = getRedis();
    if (redis) {
      await Promise.all([
        redis.set(`retention:strategy:${strategy}`, JSON.stringify(next), 'EX', STATS_TTL_SECONDS),
        redis.set(
          `retention:attribution:${String(channel).toLowerCase()}:${String(viewer).toLowerCase()}`,
          JSON.stringify(attribution),
          'EX',
          ATTRIBUTION_TTL_SECONDS,
        ),
      ]);
    } else {
      memoryStats.set(strategy, next);
      memoryAttributions.set(attributionKey(channel, viewer), {
        ...attribution,
        expiresAt: at + ATTRIBUTION_TTL_SECONDS * 1000,
      });
    }
    return next;
  }

  static async recordReply({ channel, viewer, at = Date.now() }) {
    const redis = getRedis();
    const key = attributionKey(channel, viewer);
    let attribution;

    if (redis) {
      attribution = parse(await redis.get(`retention:attribution:${key}`), null);
    } else {
      attribution = memoryAttributions.get(key) || null;
      if (attribution?.expiresAt && attribution.expiresAt < at) {
        memoryAttributions.delete(key);
        attribution = null;
      }
    }

    if (!attribution || attribution.responded) return { attributed: false, reason: 'none' };
    if (at - Number(attribution.at || 0) < 0 || at - Number(attribution.at || 0) > Number(attribution.replyWindowMs || DEFAULT_REPLY_WINDOW_MS)) {
      return { attributed: false, reason: 'expired', strategy: attribution.strategy };
    }

    const stats = await this.getStrategyStats(attribution.strategy);
    const next = {
      impressions: stats.impressions,
      replies: Math.min(stats.impressions, stats.replies + 1),
    };
    const completed = { ...attribution, responded: true, respondedAt: at };

    if (redis) {
      await Promise.all([
        redis.set(`retention:strategy:${attribution.strategy}`, JSON.stringify(next), 'EX', STATS_TTL_SECONDS),
        redis.set(`retention:attribution:${key}`, JSON.stringify(completed), 'EX', ATTRIBUTION_TTL_SECONDS),
      ]);
    } else {
      memoryStats.set(attribution.strategy, next);
      memoryAttributions.set(key, {
        ...completed,
        expiresAt: at + ATTRIBUTION_TTL_SECONDS * 1000,
      });
    }

    return {
      attributed: true,
      strategy: attribution.strategy,
      latencyMs: at - Number(attribution.at || at),
      stats: next,
    };
  }

  static async getAllStats(strategies) {
    const rows = [];
    for (const strategy of strategies) {
      rows.push({ strategy, ...(await this.getStrategyStats(strategy)) });
    }
    return rows;
  }

  static clearMemoryForTests() {
    memoryStats.clear();
    memoryAttributions.clear();
  }
}
