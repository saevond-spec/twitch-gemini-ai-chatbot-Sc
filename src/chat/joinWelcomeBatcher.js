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
    flushMs = 100,
    dedupeMs = 60_000,
    onFlush = async () => false,
    now = () => Date.now(),
  } = {}) {
    this.flushMs = Math.max(100, Number(flushMs) || 100);
    this.dedupeMs = Math.max(60_000, Number(dedupeMs) || 60_000);
    this.onFlush = onFlush;
    this.now = now;
    this.pending = new Map();
    this.timers = new Map();
    this.welcomed = new Map();
    this.inFlight = new Set();
  }

  _key(channel, username) {
    return `${String(channel || '').trim().toLowerCase()}:${String(username || '').trim().toLowerCase()}`;
  }

  _prune(now = this.now()) {
    for (const [key, expiresAt] of this.welcomed) {
      if (expiresAt <= now) this.welcomed.delete(key);
    }
  }

  hasWelcomed(channel, username, now = this.now()) {
    this._prune(now);
    const channelKey = String(channel || '').trim().toLowerCase();
    const login = String(username || '').trim().toLowerCase();
    const key = this._key(channelKey, login);
    return this.welcomed.has(key)
      || this.inFlight.has(key)
      || Boolean(this.pending.get(channelKey)?.has(login));
  }

  add(channel, username, now = this.now()) {
    const channelKey = String(channel || '').trim().toLowerCase();
    const login = String(username || '').trim().toLowerCase();
    if (!channelKey || !login) return false;
    this._prune(now);

    const key = this._key(channelKey, login);
    if (this.welcomed.has(key) || this.inFlight.has(key)) return false;

    if (!this.pending.has(channelKey)) this.pending.set(channelKey, new Set());
    const channelPending = this.pending.get(channelKey);
    if (channelPending.has(login)) return false;
    channelPending.add(login);

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
    const channelKey = String(channel || '').trim().toLowerCase();
    const names = [...(this.pending.get(channelKey) || [])];
    this.pending.delete(channelKey);

    const timer = this.timers.get(channelKey);
    if (timer) clearTimeout(timer);
    this.timers.delete(channelKey);

    const message = formatJoinWelcome(names);
    if (!message) return { channel: channelKey, names, message };

    for (const name of names) this.inFlight.add(this._key(channelKey, name));

    let settled = false;
    const settle = delivered => {
      if (settled) return;
      settled = true;
      const settledAt = this.now();
      for (const name of names) {
        const key = this._key(channelKey, name);
        this.inFlight.delete(key);
        if (delivered) this.welcomed.set(key, settledAt + this.dedupeMs);
      }
    };

    const delivery = {
      onDelivered: () => settle(true),
      onFailed: () => settle(false),
    };

    try {
      const accepted = await this.onFlush(channelKey, message, names, delivery);
      if (accepted === false) settle(false);
    } catch (err) {
      settle(false);
      throw err;
    }
    return { channel: channelKey, names, message };
  }

  stop() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
    this.inFlight.clear();
  }
}
