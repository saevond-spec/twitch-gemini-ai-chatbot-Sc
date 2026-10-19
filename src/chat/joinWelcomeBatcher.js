const SINGLE_WELCOME_OPENERS = [
  name => `Ayy @${name}, welcome in!`,
  name => `Yo @${name}, you made it!`,
  name => `What's good, @${name}?`,
  name => `Look who pulled up — @${name}!`,
  name => `@${name} just joined the chaos!`,
  name => `Hey @${name}, glad you found the stream!`,
  name => `Welcome to the lobby, @${name}!`,
  name => `The stream just got better — @${name} is here!`,
  name => `Big welcome to @${name}!`,
  name => `We got company — welcome in, @${name}!`,
  name => `@${name} rolled into chat!`,
  name => `Fresh energy in chat — welcome, @${name}!`,
  name => `The squad's got a new face: @${name}!`,
  name => `Welcome aboard, @${name}!`,
  name => `Make some room — @${name} just pulled up!`,
];

const SINGLE_WELCOME_CLOSERS = [
  "Glad you're here, cuh 😎",
  "Good to see you in chat, cuh 🤖",
  "Settle in and enjoy the stream, cuh 🎮",
  "Kick back and enjoy the chaos, cuh 😂",
  "Make yourself at home, cuh!",
];

const GROUP_WELCOME_OPENERS = [
  viewers => `Ayy, welcome in ${viewers}!`,
  viewers => `Yo ${viewers}, glad you made it!`,
  viewers => `Look who pulled up: ${viewers}!`,
  viewers => `${viewers} just joined the chaos!`,
  viewers => `Welcome to the lobby, ${viewers}!`,
  viewers => `The stream just got livelier — welcome, ${viewers}!`,
  viewers => `Big welcome to ${viewers}!`,
  viewers => `We got company — ${viewers} are here!`,
  viewers => `Fresh energy in chat: ${viewers}!`,
  viewers => `The squad's growing — welcome, ${viewers}!`,
  viewers => `Welcome aboard, ${viewers}!`,
  viewers => `${viewers} rolled into chat!`,
  viewers => `Make some room — ${viewers} just pulled up!`,
  viewers => `The chat's picking up — welcome in, ${viewers}!`,
  viewers => `Hey ${viewers}, happy to have you here!`,
];

const GROUP_WELCOME_CLOSERS = [
  "Glad you're all here, cuh 😎",
  "Good to see you all in chat, cuh 🤖",
  "Settle in and enjoy the stream, cuh 🎮",
  "Kick back and enjoy the chaos, cuh 😂",
  "Make yourselves at home, cuh!",
];

export function formatJoinWelcome(names = [], variantIndex = 0) {
  const clean = [...new Set(names.map(name => String(name || '').trim().toLowerCase()).filter(Boolean))];
  if (!clean.length) return null;

  if (clean.length === 1) {
    const index = Math.abs(Math.trunc(Number(variantIndex) || 0))
      % (SINGLE_WELCOME_OPENERS.length * SINGLE_WELCOME_CLOSERS.length);
    const opener = SINGLE_WELCOME_OPENERS[Math.floor(index / SINGLE_WELCOME_CLOSERS.length)](clean[0]);
    const closer = SINGLE_WELCOME_CLOSERS[index % SINGLE_WELCOME_CLOSERS.length];
    return `${opener} ${closer}`;
  }

  const shown = clean.slice(0, 8).map(name => `@${name}`);
  const extra = clean.length - shown.length;
  const viewers = extra > 0 ? `${shown.join(', ')} and ${extra} more` : shown.join(', ');
  const index = Math.abs(Math.trunc(Number(variantIndex) || 0))
    % (GROUP_WELCOME_OPENERS.length * GROUP_WELCOME_CLOSERS.length);
  const opener = GROUP_WELCOME_OPENERS[Math.floor(index / GROUP_WELCOME_CLOSERS.length)](viewers);
  const closer = GROUP_WELCOME_CLOSERS[index % GROUP_WELCOME_CLOSERS.length];
  return `${opener} ${closer}`;
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
    this.variantSequence = new Map();
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

    const variantIndex = this.variantSequence.get(channelKey) || 0;
    const message = formatJoinWelcome(names, variantIndex);
    if (!message) return { channel: channelKey, names, message };
    this.variantSequence.set(channelKey, variantIndex + 1);

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
