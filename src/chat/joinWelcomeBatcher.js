export function formatJoinWelcome(names = []) {
  const clean = [...new Set(names.map(name => String(name || '').trim().toLowerCase()).filter(Boolean))];
  if (!clean.length) return null;

  if (clean.length === 1) {
    return `Welcome in @${clean[0]}! 🤖 Glad you're here — chat whenever you feel like it.`;
  }

  const shown = clean.slice(0, 8).map(name => `@${name}`);
  const extra = clean.length - shown.length;
  if (extra > 0) {
    return `Welcome in ${shown.join(', ')} and ${extra} more! 🤖 Glad you're all here.`;
  }
  return `Welcome in ${shown.join(', ')}! 🤖 Glad you're all here.`;
}

export class JoinWelcomeBatcher {
  constructor({
    flushMs = 2500,
    dedupeMs = 6 * 60 * 60 * 1000,
    onFlush = async () => {},
    now = () => Date.now(),
  } = {}) {
    this.flushMs = Math.max(250, Number(flushMs) || 2500);
    this.dedupeMs = Math.max(60_000, Number(dedupeMs) || 6 * 60 * 60 * 1000);
    this.onFlush = onFlush;
    this.now = now;
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
