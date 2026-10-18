export function formatJoinWelcome(names = []) {
  const clean = [...new Set(names.map(name => String(name || '').trim().toLowerCase()).filter(Boolean))];
  if (!clean.length) return null;

  // Never expose silent usernames. A generic welcome preserves the user's
  // "welcome everybody" preference without making a lurker feel singled out.
  if (clean.length === 1) {
    return 'Welcome in! 🤖 Make yourself comfortable — chat whenever you feel like it.';
  }
  return 'Welcome in, everyone! 🤖 Grab a seat — no pressure to type, jump in whenever you want.';
}

export class JoinWelcomeBatcher {
  constructor({
    flushMs = 2500,
    dedupeMs = 6 * 60 * 60 * 1000,
    warmupMs = 20_000,
    onFlush = async () => {},
    now = () => Date.now(),
  } = {}) {
    this.flushMs = Math.max(250, Number(flushMs) || 2500);
    this.dedupeMs = Math.max(60_000, Number(dedupeMs) || 6 * 60 * 60 * 1000);
    this.warmupMs = Math.max(0, Number(warmupMs) || 0);
    this.onFlush = onFlush;
    this.now = now;
    this.startedAt = this.now();
    this.pending = new Map();
    this.timers = new Map();
    this.welcomed = new Map();
  }

  _key(channel, username) {
    return `${String(channel || '').toLowerCase()}:${String(username || '').toLowerCase()}`;
  }

  _prune(now = this.now()) {
    for (const [key, expiresAt] of this.welcomed) {
      if (expiresAt <= now) this.welcomed.delete(key);
    }
  }

  hasWelcomed(channel, username, now = this.now()) {
    this._prune(now);
    return this.welcomed.has(this._key(channel, username));
  }

  add(channel, username, now = this.now()) {
    if (!channel || !username) return false;
    if (now - this.startedAt < this.warmupMs) return false;

    this._prune(now);
    const key = this._key(channel, username);
    if (this.welcomed.has(key)) return false;
    this.welcomed.set(key, now + this.dedupeMs);

    const channelKey = String(channel).toLowerCase();
    if (!this.pending.has(channelKey)) this.pending.set(channelKey, new Set());
    this.pending.get(channelKey).add(String(username).toLowerCase());

    if (!this.timers.has(channelKey)) {
      const timer = setTimeout(() => {
        this.flush(channelKey).catch(() => {});
      }, this.flushMs);
      timer.unref?.();
      this.timers.set(channelKey, timer);
    }
    return true;
  }

  async flush(channel) {
    const channelKey = String(channel || '').toLowerCase();
    const names = [...(this.pending.get(channelKey) || [])];
    this.pending.delete(channelKey);

    const timer = this.timers.get(channelKey);
    if (timer) clearTimeout(timer);
    this.timers.delete(channelKey);

    const message = formatJoinWelcome(names);
    if (message) await this.onFlush(channelKey, message, names);
    return { channel: channelKey, names, message };
  }

  stop() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
  }
}
