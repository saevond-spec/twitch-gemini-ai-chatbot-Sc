import { getRedis } from '../storage/redis.js';
import { createLogger } from '../logger/index.js';

const log = createLogger('CONVERSATION');
const MAX_HISTORY = 100;
const TTL_SECONDS = 86400;
const TTL_MS = TTL_SECONDS * 1000;
const MAX_LOCAL_CHANNELS = 32;

function memoryKey(channel) {
  return String(channel || '').trim().toLowerCase();
}

function parseEntry(raw) {
  try {
    const entry = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!entry || typeof entry !== 'object' || !Number.isFinite(Number(entry.ts))) return null;
    return { ...entry, ts: Number(entry.ts) };
  } catch {
    return null;
  }
}

function entryKey(entry) {
  return [entry.ts, entry.role, entry.username || '', entry.content || ''].join('\\u0000');
}

function mergeEntries(remote, local) {
  const unique = new Map();
  for (const entry of [...remote, ...local]) {
    const parsed = parseEntry(entry);
    if (parsed) unique.set(entryKey(parsed), parsed);
  }
  return [...unique.values()].sort((a, b) => a.ts - b.ts);
}

export function createConversationStore({
  redisProvider = getRedis,
  now = () => Date.now(),
  logger = log,
} = {}) {
  const local = new Map();
  let warnedAboutRedis = false;

  function warnRedisFallback(err) {
    if (warnedAboutRedis) return;
    warnedAboutRedis = true;
    logger.warn('Conversation persistence unavailable; retaining bounded in-memory history for this process', err?.message || err);
  }

  function stateFor(channel, at = now()) {
    const key = memoryKey(channel);
    if (!key) return { history: [], lastActivity: 0, touchedAt: at };
    let state = local.get(key);
    if (!state) {
      state = { history: [], lastActivity: 0, touchedAt: at };
      local.set(key, state);
    }
    const cutoff = at - TTL_MS;
    state.history = state.history.filter(entry => Number(entry.ts || 0) >= cutoff);
    if (state.lastActivity && state.lastActivity < cutoff) state.lastActivity = 0;
    state.touchedAt = at;

    if (local.size > MAX_LOCAL_CHANNELS) {
      const oldest = [...local.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0];
      if (oldest && oldest[0] !== key) local.delete(oldest[0]);
    }
    return state;
  }

  function getRedisClient() {
    try {
      return redisProvider?.() || null;
    } catch (err) {
      warnRedisFallback(err);
      return null;
    }
  }

  return {
    async pushMessage(channel, role, content, username = null) {
      const ts = now();
      const entry = { role, content, ts, username };
      const state = stateFor(channel, ts);
      state.history.push(entry);
      if (state.history.length > MAX_HISTORY) state.history.splice(0, state.history.length - MAX_HISTORY);
      if (role === 'user') state.lastActivity = Math.max(state.lastActivity || 0, ts);

      const redis = getRedisClient();
      if (!redis) return entry;
      try {
        const key = `conv:${channel}`;
        const serialized = JSON.stringify(entry);
        await redis.lpush(key, serialized);
        await redis.ltrim(key, 0, MAX_HISTORY - 1);
        await redis.expire(key, TTL_SECONDS);
        warnedAboutRedis = false;
      } catch (err) {
        warnRedisFallback(err);
      }
      return entry;
    },

    async getHistory(channel, limit = 20) {
      const count = Math.max(0, Math.min(MAX_HISTORY, Math.floor(Number(limit) || 20)));
      if (!count) return [];
      const state = stateFor(channel);
      const redis = getRedisClient();
      if (!redis) return state.history.slice(-count);

      try {
        const items = await redis.lrange(`conv:${channel}`, 0, count - 1);
        const remote = (items || []).map(parseEntry).filter(Boolean).reverse();
        warnedAboutRedis = false;
        return mergeEntries(remote, state.history).slice(-count);
      } catch (err) {
        warnRedisFallback(err);
        return state.history.slice(-count);
      }
    },

    async getLastActivity(channel) {
      const state = stateFor(channel);
      const redis = getRedisClient();
      if (!redis) return state.lastActivity || 0;

      try {
        const raw = await redis.get(`lastact:${channel}`);
        const remote = raw ? Number.parseInt(raw, 10) || 0 : 0;
        const latest = Math.max(remote, state.lastActivity || 0);
        if (latest > remote) await redis.set(`lastact:${channel}`, String(latest), 'EX', TTL_SECONDS);
        warnedAboutRedis = false;
        state.lastActivity = latest;
        return latest;
      } catch (err) {
        warnRedisFallback(err);
        return state.lastActivity || 0;
      }
    },

    async updateLastActivity(channel, timestamp = now()) {
      const state = stateFor(channel);
      const activity = Number(timestamp);
      if (Number.isFinite(activity) && activity > 0) state.lastActivity = Math.max(state.lastActivity || 0, activity);

      const redis = getRedisClient();
      if (!redis) return state.lastActivity || 0;
      try {
        await redis.set(`lastact:${channel}`, String(state.lastActivity || activity), 'EX', TTL_SECONDS);
        warnedAboutRedis = false;
      } catch (err) {
        warnRedisFallback(err);
      }
      return state.lastActivity || activity;
    },
  };
}

export const ConversationStore = createConversationStore();
