// Individually written full messages keep the rotation varied for regular viewers.
const WELCOME_VARIANTS = [
  "Ayy, welcome in, {{audience}}! Glad you made it, cuh 😎",
  "Yo, {{audience}}—good to see you in chat, cuh 🤖",
  "{{audience}} pulled up! Settle in and enjoy the chaos, cuh 🎮",
  "What's good, {{audience}}? Hope you're having a good one, cuh 😄",
  "Welcome to the lobby, {{audience}}! Let's see what happens next, cuh 🎮",
  "Glad you caught us live, {{audience}}; kick back and enjoy, cuh 😎",
  "Big welcome to {{audience}}! The gameplay starts now, cuh 🎮",
  "Hey, {{audience}}—glad you're hanging out with us, cuh 🤖",
  "Chat just got livelier with {{audience}} here—welcome, cuh 😄",
  "Welcome aboard, {{audience}}! Settle in for some action, cuh 🎮",
  "Ayy {{audience}}, hope the stream treats you right, cuh 😎",
  "Yo, welcome to the chaos, {{audience}}! Glad you're here, cuh 😂",
  "{{audience}}, you're right on time—welcome in, cuh 🤖",
  "Good vibes, good game, and {{audience}} in chat—welcome, cuh 😎",
  "Hey there, {{audience}}! Kick back and enjoy the show, cuh 🤖",
  "{{audience}} made it to the stream—good to have you, cuh 🎮",
  "Ayy, the party's better with {{audience}} here, cuh 😎",
  "Welcome in, {{audience}}! Hope we get a highlight for you, cuh 🎮",
  "{{audience}}, glad you found this corner of Twitch—welcome, cuh 🤖",
  "Yo {{audience}}, good timing—the stream's getting interesting, cuh 😄",
  "Make some room in chat—{{audience}} just arrived, cuh 😂",
  "Hey {{audience}}, welcome to the stream! Glad you found us, cuh 🤖",
  "Ayy {{audience}}, good timing—welcome in, cuh 😎",
  "Welcome to today's stream, {{audience}}! Enjoy the ride, cuh 🎮",
  "{{audience}}, glad you're here for the next match, cuh 😄",
  "Yo, chat says welcome, {{audience}}—glad you made it, cuh 🤖",
  "Ayy {{audience}}, the vibes are right—welcome in, cuh 😎",
  "Here's a warm welcome, {{audience}}; enjoy the stream, cuh 😄",
  "{{audience}}, welcome to the chat—settle in at your own pace, cuh 🤖",
  "Welcome, {{audience}}! Let's see if we can clutch this, cuh 🎮",
  "Yo {{audience}}, hope the next play is a banger, cuh 😄",
  "Ayy, welcome to the hangout, {{audience}}! Chill and enjoy, cuh 😎",
  "{{audience}}, thanks for dropping by—hope you enjoy the stream, cuh 😄",
  "Welcome in, {{audience}}! No pressure, just vibes, cuh 😎",
  "What's up, {{audience}}? Glad you're here—make yourself comfy, cuh 🤖",
  "Welcome to the watch party, {{audience}}! Glad you're here, cuh 🎮",
  "Ayy, welcome to the stream, {{audience}}—glad you rolled through, cuh 😎",
  "Yo {{audience}}, settle in and enjoy the match, cuh 🎮",
  "It's a W having {{audience}} in chat—welcome, cuh 😎",
  "The chat's looking good with {{audience}} here—welcome, cuh 🤖",
  "Ayy, welcome aboard, {{audience}}; we're glad you're here, cuh 😄",
  "Glad you've joined us, {{audience}}; let's have some fun, cuh 😎",
  "Come catch a vibe with us, {{audience}}—welcome in, cuh 🤖",
  "{{audience}}, we're rolling—glad you joined us, cuh 🎮",
  "Welcome, {{audience}}! Hope you catch a clutch moment, cuh 🎮",
  "Welcome in, {{audience}}; chat's open whenever you feel like jumping in, cuh 🤖",
  "The stream just got a fresh boost—welcome, {{audience}}, cuh 😎",
  "Yo {{audience}}, glad you rolled through; enjoy the gameplay, cuh 🎮",
  "Ayy {{audience}}, good to have you here—stay comfy, cuh 😄",
  "Welcome to the squad, {{audience}}! Enjoy the gameplay, cuh 🎮",
  "Good to have you, {{audience}}—welcome in and enjoy the ride, cuh 😎",
  "Good to have you here, {{audience}}; the chaos awaits, cuh 😂",
  "Welcome in, {{audience}}! Let's make this a fun one, cuh 🤖",
  "Ayy {{audience}}, thanks for joining the stream—good to have you, cuh 😎",
  "Hey {{audience}}, perfect timing—welcome in, cuh 😄",
  "Yo, the stream is more fun with {{audience}} here—welcome, cuh 😎",
  "{{audience}}, welcome to the channel! Let's enjoy this moment, cuh 🎮",
  "Ayy {{audience}}, good to have you along for the match, cuh 🎮",
  "Welcome in, {{audience}}! Hope you enjoy this little gaming detour, cuh 😄",
  "Yo {{audience}}, let's see if the next play makes the highlight reel, cuh 🎮",
  "{{audience}}, pull up and catch the action—welcome to the stream, cuh 😎",
  "Ayy, glad to have {{audience}} in here—welcome, cuh 🤖",
  "Welcome to our little corner of Twitch, {{audience}}; enjoy the show, cuh 😄",
  "Yo {{audience}}, enjoy the gameplay and the occasional chaos, cuh 😂",
  "Ayy, you made it, {{audience}}! Time for the good stuff, cuh 😎",
  "Welcome, {{audience}}; you're always welcome to hang out here, cuh 🤖",
  "{{audience}}, take in the stream at your own pace—glad you're here, cuh 😄",
  "Yo {{audience}}, you've got front-row seats to the chaos, cuh 😂",
  "Ayy, glad you joined us, {{audience}}; let the match begin, cuh 🎮",
  "Welcome in, {{audience}}! The chat's got room for your emotes, cuh 🤖",
  "What's good, {{audience}}? We're happy to have you here, cuh 😎",
  "Hey {{audience}}, hope the stream brings a smile—welcome in, cuh 😄",
  "Ayy {{audience}}, good energy in chat—welcome to the stream, cuh 🤖",
  "{{audience}}, thanks for being part of this moment; enjoy the stream, cuh 😎",
  "Yo {{audience}}, glad you landed here—kick back and catch the action, cuh 🎮",
];

export function formatJoinWelcome(names = [], variantIndex = 0) {
  const clean = [...new Set(names.map(name => String(name || '').trim().toLowerCase()).filter(Boolean))];
  if (!clean.length) return null;

  const shown = clean.slice(0, 8).map(name => `@${name}`);
  const extra = clean.length - shown.length;
  const audience = clean.length === 1
    ? shown[0]
    : extra > 0 ? `${shown.join(', ')} and ${extra} more` : shown.join(', ');
  const index = Math.abs(Math.trunc(Number(variantIndex) || 0)) % WELCOME_VARIANTS.length;
  return WELCOME_VARIANTS[index].replaceAll('{{audience}}', audience);
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
