import { getRedis } from '../storage/redis.js';
import { posteriorFromCounts } from './math.js';

const ATTRIBUTION_TTL_SECONDS = 24 * 60 * 60;
const STATS_TTL_SECONDS = 5 * 366 * 24 * 60 * 60;
const CHANNEL_COOLDOWN_TTL_SECONDS = 24 * 60 * 60;

const memoryStats = new Map();
const memoryAttribution = new Map();
const memoryChannelPrompt = new Map();

function armKey(offerId, variantId) {
  return `${offerId}:${variantId}`;
}

function parse(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

export class CommerceStore {
  static async getArmStats(offerId, variantId) {
    const key = armKey(offerId, variantId);
    const redis = getRedis();
    let data;
    if (redis) data = parse(await redis.get(`commerce:arm:${key}`), null);
    else data = memoryStats.get(key) || null;

    const stats = {
      impressions: Number(data?.impressions || 0),
      conversions: Number(data?.conversions || 0),
      attributedValue: Number(data?.attributedValue || 0),
    };
    return { ...stats, ...posteriorFromCounts(stats) };
  }

  static async recordImpression({ channel, viewer, offerId, variantId, at = Date.now() }) {
    const key = armKey(offerId, variantId);
    const redis = getRedis();
    const stats = await this.getArmStats(offerId, variantId);
    const next = {
      impressions: stats.impressions + 1,
      conversions: stats.conversions,
      attributedValue: stats.attributedValue,
    };
    const attribution = { channel, viewer, offerId, variantId, at, converted: false };

    if (redis) {
      await Promise.all([
        redis.set(`commerce:arm:${key}`, JSON.stringify(next), 'EX', STATS_TTL_SECONDS),
        redis.set(`commerce:attribution:${channel}:${viewer}`, JSON.stringify(attribution), 'EX', ATTRIBUTION_TTL_SECONDS),
        redis.set(`commerce:channel-last:${channel}`, String(at), 'EX', CHANNEL_COOLDOWN_TTL_SECONDS),
      ]);
    } else {
      memoryStats.set(key, next);
      memoryAttribution.set(`${channel}:${viewer}`, { ...attribution, expiresAt: at + ATTRIBUTION_TTL_SECONDS * 1000 });
      memoryChannelPrompt.set(channel, at);
    }
    return next;
  }

  static async getAttribution(channel, viewer, now = Date.now()) {
    const redis = getRedis();
    let attribution;
    if (redis) attribution = parse(await redis.get(`commerce:attribution:${channel}:${viewer}`), null);
    else {
      attribution = memoryAttribution.get(`${channel}:${viewer}`) || null;
      if (attribution?.expiresAt && attribution.expiresAt < now) {
        memoryAttribution.delete(`${channel}:${viewer}`);
        return null;
      }
    }
    if (!attribution || attribution.converted) return null;
    if (now - Number(attribution.at || 0) > ATTRIBUTION_TTL_SECONDS * 1000) return null;
    return attribution;
  }

  static async recordAttributedConversion({ channel, viewer, expectedOfferId = null, value = 0, at = Date.now() }) {
    const attribution = await this.getAttribution(channel, viewer, at);
    if (!attribution) return { attributed: false, reason: 'no_attribution' };
    if (expectedOfferId && attribution.offerId !== expectedOfferId) {
      return { attributed: false, reason: 'offer_mismatch', attribution };
    }

    const redis = getRedis();
    const stats = await this.getArmStats(attribution.offerId, attribution.variantId);
    const next = {
      impressions: stats.impressions,
      conversions: Math.min(stats.impressions, stats.conversions + 1),
      attributedValue: stats.attributedValue + Math.max(0, Number(value) || 0),
    };
    const completed = { ...attribution, converted: true, convertedAt: at, value: Math.max(0, Number(value) || 0) };
    const key = armKey(attribution.offerId, attribution.variantId);

    if (redis) {
      await Promise.all([
        redis.set(`commerce:arm:${key}`, JSON.stringify(next), 'EX', STATS_TTL_SECONDS),
        redis.set(`commerce:attribution:${channel}:${viewer}`, JSON.stringify(completed), 'EX', ATTRIBUTION_TTL_SECONDS),
      ]);
    } else {
      memoryStats.set(key, next);
      memoryAttribution.set(`${channel}:${viewer}`, { ...completed, expiresAt: at + ATTRIBUTION_TTL_SECONDS * 1000 });
    }
    return { attributed: true, attribution, stats: next };
  }

  static async getLastChannelPromptAt(channel) {
    const redis = getRedis();
    if (redis) return Number(await redis.get(`commerce:channel-last:${channel}`) || 0);
    return Number(memoryChannelPrompt.get(channel) || 0);
  }

  static async getAllStats(catalog) {
    const rows = [];
    for (const offer of catalog) {
      for (const variant of offer.variants) {
        rows.push({ offerId: offer.id, variantId: variant.id, ...(await this.getArmStats(offer.id, variant.id)) });
      }
    }
    return rows;
  }

  static clearMemoryForTests() {
    memoryStats.clear();
    memoryAttribution.clear();
    memoryChannelPrompt.clear();
  }
}
