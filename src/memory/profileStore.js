import { getRedis } from '../storage/redis.js';

const PROFILE_TTL_SECONDS = 30 * 24 * 60 * 60;
const SEEN_TTL_SECONDS = 2 * 365 * 24 * 60 * 60;
const memoryProfiles = new Map();
const memorySeen = new Map();

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

function memoryKey(channel, viewer) {
  return `${channel}:${viewer}`;
}

function pruneMemory(now = Date.now()) {
  const profileCutoff = now - PROFILE_TTL_SECONDS * 1000;
  const seenCutoff = now - SEEN_TTL_SECONDS * 1000;

  for (const [key, value] of memoryProfiles) {
    if ((value.lastSeen || 0) < profileCutoff) memoryProfiles.delete(key);
  }
  for (const [key, lastSeen] of memorySeen) {
    if (lastSeen < seenCutoff) memorySeen.delete(key);
  }
}

export class ProfileStore {
  static async get(channel, viewer) {
    const key = memoryKey(channel, viewer);
    const redis = getRedis();

    if (!redis) {
      pruneMemory();
      const existing = memoryProfiles.get(key);
      const seenBefore = memorySeen.has(key);
      return existing ? { ...defaults(), ...existing, seenBefore: true } : { ...defaults(), seenBefore };
    }

    const [data, seen] = await Promise.all([
      redis.get(`profile:${channel}:${viewer}`),
      redis.get(`profile-seen:${channel}:${viewer}`),
    ]);

    if (!data) return { ...defaults(), seenBefore: Boolean(seen) };
    try {
      return { ...defaults(), ...JSON.parse(data), seenBefore: true };
    } catch {
      return { ...defaults(), seenBefore: Boolean(seen) };
    }
  }

  static async update(channel, viewer, updates) {
    const key = memoryKey(channel, viewer);
    const profile = await this.get(channel, viewer);
    Object.assign(profile, updates, { lastSeen: Date.now(), seenBefore: true });

    const redis = getRedis();
    if (!redis) {
      memoryProfiles.set(key, profile);
      memorySeen.set(key, profile.lastSeen);
      return;
    }

    await Promise.all([
      redis.set(`profile:${channel}:${viewer}`, JSON.stringify(profile), 'EX', PROFILE_TTL_SECONDS),
      redis.set(`profile-seen:${channel}:${viewer}`, String(profile.lastSeen), 'EX', SEEN_TTL_SECONDS),
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
    memorySeen.clear();
  }
}
