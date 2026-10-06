import { getRedis } from '../storage/redis.js';

const PROFILE_TTL_SECONDS = 30 * 24 * 60 * 60;
const STATE_TTL_SECONDS = 2 * 365 * 24 * 60 * 60;
const memoryProfiles = new Map();
const memoryState = new Map();

function defaults(now = Date.now()) {
  return {
    firstSeen: now,
    lastSeen: now,
    firstChatAt: null,
    messageCount: 0,
    botInteractions: 0,
    followed: false,
    followedAt: null,
    followPromptedAt: null,
    proactiveOptOut: false,
    seenBefore: false,
    preferences: {},
    notes: [],
  };
}

function key(channel, viewer) {
  return `${channel}:${viewer}`;
}

function durableState(profile) {
  return {
    seenBefore: true,
    firstSeen: profile.firstSeen,
    lastSeen: profile.lastSeen,
    followed: Boolean(profile.followed),
    followedAt: profile.followedAt || null,
    followPromptedAt: profile.followPromptedAt || null,
    proactiveOptOut: Boolean(profile.proactiveOptOut),
  };
}

function pruneMemory(now = Date.now()) {
  const profileCutoff = now - PROFILE_TTL_SECONDS * 1000;
  const stateCutoff = now - STATE_TTL_SECONDS * 1000;

  for (const [entryKey, value] of memoryProfiles) {
    if ((value.lastSeen || 0) < profileCutoff) memoryProfiles.delete(entryKey);
  }
  for (const [entryKey, value] of memoryState) {
    if ((value.lastSeen || 0) < stateCutoff) memoryState.delete(entryKey);
  }
}

export class ProfileStore {
  static async get(channel, viewer) {
    const entryKey = key(channel, viewer);
    const redis = getRedis();

    if (!redis) {
      pruneMemory();
      const detailed = memoryProfiles.get(entryKey);
      const durable = memoryState.get(entryKey);
      return { ...defaults(), ...(durable || {}), ...(detailed || {}) };
    }

    const [data, stateData] = await Promise.all([
      redis.get(`profile:${channel}:${viewer}`),
      redis.get(`profile-state:${channel}:${viewer}`),
    ]);

    let durable = {};
    if (stateData) {
      try { durable = JSON.parse(stateData); } catch {}
    }

    if (!data) return { ...defaults(), ...durable };
    try {
      return { ...defaults(), ...durable, ...JSON.parse(data) };
    } catch {
      return { ...defaults(), ...durable };
    }
  }

  static async update(channel, viewer, updates) {
    const entryKey = key(channel, viewer);
    const profile = await this.get(channel, viewer);
    Object.assign(profile, updates, { lastSeen: Date.now(), seenBefore: true });
    const durable = durableState(profile);

    const redis = getRedis();
    if (!redis) {
      memoryProfiles.set(entryKey, profile);
      memoryState.set(entryKey, durable);
      return;
    }

    await Promise.all([
      redis.set(`profile:${channel}:${viewer}`, JSON.stringify(profile), 'EX', PROFILE_TTL_SECONDS),
      redis.set(`profile-state:${channel}:${viewer}`, JSON.stringify(durable), 'EX', STATE_TTL_SECONDS),
    ]);
  }

  static async addNote(channel, viewer, note) {
    const profile = await this.get(channel, viewer);
    profile.notes.push({ text: note, timestamp: Date.now() });
    profile.notes = profile.notes.slice(-25);
    await this.update(channel, viewer, profile);
  }

  static clearMemoryFallbackForTests() {
    memoryProfiles.clear();
    memoryState.clear();
  }
}
