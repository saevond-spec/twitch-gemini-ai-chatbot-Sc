import { getRedis } from '../storage/redis.js';

const STATS_TTL_SECONDS = 180 * 24 * 60 * 60;
const ACTIVE_TTL_SECONDS = 5 * 60;
const memoryStats = new Map();
const memoryActive = new Map();

function channelKey(channel) {
  return String(channel || '').replace(/^#?/, '#').toLowerCase();
}

function statKey(channel, arm) {
  return `lurker-activation:arm:${channelKey(channel)}:${arm}`;
}

function activeKey(channel) {
  return `lurker-activation:active:${channelKey(channel)}`;
}

function parse(raw, fallback = null) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

function defaults(data = null) {
  const impressions = Math.max(0, Number(data?.impressions || 0));
  const successes = Math.max(0, Math.min(impressions, Number(data?.successes || 0)));
  return {
    impressions,
    successes,
    activatedUsers: Math.max(successes, Number(data?.activatedUsers || 0)),
    alpha: 1 + successes,
    beta: 9 + impressions - successes,
  };
}

export class LurkerActivationStore {
  static async getArmStats(channel, arm) {
    const redis = getRedis();
    const key = statKey(channel, arm);
    let data;
    if (redis) data = parse(await redis.get(key), null);
    else data = memoryStats.get(key) || null;
    return defaults(data);
  }

  static async recordPrompt({ channel, arm, eligibleSilentUsers, at = Date.now(), windowMs = 120_000 }) {
    const stats = await this.getArmStats(channel, arm);
    const next = {
      impressions: stats.impressions + 1,
      successes: stats.successes,
      activatedUsers: stats.activatedUsers,
    };
    const active = {
      arm,
      at,
      expiresAt: at + windowMs,
      eligibleSilentUsers: Math.max(0, Number(eligibleSilentUsers) || 0),
      successCredited: false,
      activatedUsers: 0,
    };

    const redis = getRedis();
    if (redis) {
      await Promise.all([
        redis.set(statKey(channel, arm), JSON.stringify(next), 'EX', STATS_TTL_SECONDS),
        redis.set(activeKey(channel), JSON.stringify(active), 'EX', ACTIVE_TTL_SECONDS),
      ]);
    } else {
      memoryStats.set(statKey(channel, arm), next);
      memoryActive.set(activeKey(channel), active);
    }
    return active;
  }

  static async getActivePrompt(channel, now = Date.now()) {
    const redis = getRedis();
    const key = activeKey(channel);
    let active;
    if (redis) active = parse(await redis.get(key), null);
    else active = memoryActive.get(key) || null;
    if (!active) return null;
    if (Number(active.expiresAt || 0) < now) {
      if (redis) await redis.del(key);
      else memoryActive.delete(key);
      return null;
    }
    return active;
  }

  static async recordActivation({ channel, at = Date.now() }) {
    const active = await this.getActivePrompt(channel, at);
    if (!active) return { attributed: false, reason: 'no_active_prompt' };

    const stats = await this.getArmStats(channel, active.arm);
    const firstSuccess = !active.successCredited;
    const next = {
      impressions: stats.impressions,
      successes: stats.successes + (firstSuccess ? 1 : 0),
      activatedUsers: stats.activatedUsers + 1,
    };
    const updatedActive = {
      ...active,
      successCredited: true,
      activatedUsers: Number(active.activatedUsers || 0) + 1,
    };

    const redis = getRedis();
    if (redis) {
      await Promise.all([
        redis.set(statKey(channel, active.arm), JSON.stringify(next), 'EX', STATS_TTL_SECONDS),
        redis.set(activeKey(channel), JSON.stringify(updatedActive), 'EX', ACTIVE_TTL_SECONDS),
      ]);
    } else {
      memoryStats.set(statKey(channel, active.arm), next);
      memoryActive.set(activeKey(channel), updatedActive);
    }

    return {
      attributed: true,
      arm: active.arm,
      firstSuccess,
      latencyMs: at - Number(active.at || at),
      activatedUsers: updatedActive.activatedUsers,
    };
  }

  static async getAllStats(channel, arms) {
    const rows = [];
    for (const arm of arms) rows.push({ arm, ...(await this.getArmStats(channel, arm)) });
    return rows;
  }

  static clearMemoryForTests() {
    memoryStats.clear();
    memoryActive.clear();
  }
}
