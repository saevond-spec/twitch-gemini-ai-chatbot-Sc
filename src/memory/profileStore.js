import { getRedis } from '../storage/redis.js';

const TTL_SECONDS = 2592000;
const memoryProfiles = new Map();

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
    preferences: {},
    notes: [],
  };
}

function memoryKey(channel, viewer) {
  return `${channel}:${viewer}`;
}

function pruneMemory(now = Date.now()) {
  const cutoff = now - TTL_SECONDS * 1000;
  for (const [key, value] of memoryProfiles) {
    if ((value.lastSeen || 0) < cutoff) memoryProfiles.delete(key);
  }
}

export class ProfileStore {
  static async get(channel, viewer) {
    const redis = getRedis();
    if (!redis) {
      pruneMemory();
      const existing = memoryProfiles.get(memoryKey(channel, viewer));
      return existing ? { ...defaults(), ...existing } : defaults();
    }

    const data = await redis.get(`profile:${channel}:${viewer}`);
    if (!data) return defaults();
    try {
      return { ...defaults(), ...JSON.parse(data) };
    } catch {
      return defaults();
    }
  }

  static async update(channel, viewer, updates) {
    const profile = await this.get(channel, viewer);
    Object.assign(profile, updates, { lastSeen: Date.now() });

    const redis = getRedis();
    if (!redis) {
      memoryProfiles.set(memoryKey(channel, viewer), profile);
      return;
    }

    await redis.set(`profile:${channel}:${viewer}`, JSON.stringify(profile), 'EX', TTL_SECONDS);
  }

  static async addNote(channel, viewer, note) {
    const profile = await this.get(channel, viewer);
    profile.notes.push({ text: note, timestamp: Date.now() });
    profile.notes = profile.notes.slice(-25);
    await this.update(channel, viewer, profile);
  }

  static clearMemoryFallbackForTests() {
    memoryProfiles.clear();
  }
}
