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

function normalizeLanguage(language = 'global') {
  const value = String(language || 'global').toLowerCase();
  return /^[a-z]{2,3}$/.test(value) ? value : 'global';
}

function statsKey(strategy, language = 'global') {
  return `retention:strategy:${normalizeLanguage(language)}:${strategy}`;
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

async function readStats(strategy, language) {
  const key = statsKey(strategy, language);
  const redis = getRedis();
  let data;
  if (redis) data = parse(await redis.get(key), null);
  else data = memoryStats.get(key) || null;
  return statDefaults(data);
}

async function writeStats(strategy, language, next) {
  const key = statsKey(strategy, language);
  const redis = getRedis();
  if (redis) await redis.set(key, JSON.stringify(next), 'EX', STATS_TTL_SECONDS);
  else memoryStats.set(key, next);
}

export class RetentionStore {
  static async getStrategyStats(strategy, language = 'global') {
    const lang = normalizeLanguage(language);
    const local = await readStats(strategy, lang);
    if (lang === 'global') return { ...local, language: lang };

    const global = await readStats(strategy, 'global');
    const globalMean = global.alpha / Math.max(1, global.alpha + global.beta);
    const poolingWeight = 4;

    // Empirical-Bayes shrinkage: language-specific evidence dominates as it
    // grows, while sparse languages borrow a small amount from the global arm.
    return {
      ...local,
      language: lang,
      alpha: local.alpha + poolingWeight * globalMean,
      beta: local.beta + poolingWeight * (1 - globalMean),
      globalImpressions: global.impressions,
      globalReplies: global.replies,
    };
  }

  static async recordImpression({
    channel,
    viewer,
    strategy,
    language = 'global',
    at = Date.now(),
    replyWindowMs = DEFAULT_REPLY_WINDOW_MS,
  }) {
    const lang = normalizeLanguage(language);
    const localCurrent = await readStats(strategy, lang);
    const localNext = {
      impressions: localCurrent.impressions + 1,
      replies: localCurrent.replies,
    };

    const writes = [writeStats(strategy, lang, localNext)];

    if (lang !== 'global') {
      const globalCurrent = await readStats(strategy, 'global');
      writes.push(writeStats(strategy, 'global', {
        impressions: globalCurrent.impressions + 1,
        replies: globalCurrent.replies,
      }));
    }

    const attribution = {
      strategy,
      language: lang,
      at,
      replyWindowMs,
      responded: false,
    };

    const redis = getRedis();
    if (redis) {
      writes.push(redis.set(
        `retention:attribution:${attributionKey(channel, viewer)}`,
        JSON.stringify(attribution),
        'EX',
        ATTRIBUTION_TTL_SECONDS,
      ));
    } else {
      memoryAttributions.set(attributionKey(channel, viewer), {
        ...attribution,
        expiresAt: at + ATTRIBUTION_TTL_SECONDS * 1000,
      });
    }

    await Promise.all(writes);
    return localNext;
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
      return {
        attributed: false,
        reason: 'expired',
        strategy: attribution.strategy,
        language: attribution.language || 'global',
      };
    }

    const language = normalizeLanguage(attribution.language);
    const local = await readStats(attribution.strategy, language);
    const localNext = {
      impressions: local.impressions,
      replies: Math.min(local.impressions, local.replies + 1),
    };

    const writes = [writeStats(attribution.strategy, language, localNext)];

    if (language !== 'global') {
      const global = await readStats(attribution.strategy, 'global');
      writes.push(writeStats(attribution.strategy, 'global', {
        impressions: global.impressions,
        replies: Math.min(global.impressions, global.replies + 1),
      }));
    }

    const completed = { ...attribution, responded: true, respondedAt: at };
    if (redis) {
      writes.push(redis.set(`retention:attribution:${key}`, JSON.stringify(completed), 'EX', ATTRIBUTION_TTL_SECONDS));
    } else {
      memoryAttributions.set(key, {
        ...completed,
        expiresAt: at + ATTRIBUTION_TTL_SECONDS * 1000,
      });
    }

    await Promise.all(writes);

    return {
      attributed: true,
      strategy: attribution.strategy,
      language,
      latencyMs: at - Number(attribution.at || at),
      stats: localNext,
    };
  }

  static async getAllStats(strategies, language = 'global') {
    const rows = [];
    for (const strategy of strategies) {
      rows.push({ strategy, ...(await this.getStrategyStats(strategy, language)) });
    }
    return rows;
  }

  static clearMemoryForTests() {
    memoryStats.clear();
    memoryAttributions.clear();
  }
}
