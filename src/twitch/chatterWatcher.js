import { createLogger } from '../logger/index.js';
import { shouldWelcomeJoin } from '../chat/joinWelcomePolicy.js';

const log = createLogger('CHATTER-WATCH');

export class ChatterWatcher {
  constructor({
    helix,
    channels = [],
    botLogin = '',
    ignoredUsers = [],
    pollMs = Number(process.env.CHATTER_WATCH_POLL_SECONDS || 30) * 1000,
    rejoinSuppressMs = Number(process.env.CHATTER_REJOIN_SUPPRESS_MINUTES || 30) * 60_000,
    onArrival = async () => {},
    now = () => Date.now(),
  } = {}) {
    this.helix = helix;
    this.channels = channels;
    this.botLogin = String(botLogin || '').toLowerCase();
    this.ignoredUsers = ignoredUsers;
    this.pollMs = Math.max(15_000, Number(pollMs) || 30_000);
    this.rejoinSuppressMs = Math.max(60_000, Number(rejoinSuppressMs) || 30 * 60_000);
    this.onArrival = onArrival;
    this.now = now;
    this.timer = null;
    this.state = new Map();
    this.pollErrors = new Map();
    this.running = false;
    this.disabledReason = null;
    this.tickPromise = null;
    this.resumePromise = null;
    this.resuming = false;
    this.firstPollPromise = null;
  }

  _channelKey(channel) {
    return String(channel || '').replace(/^#?/, '#').toLowerCase();
  }

  _stateFor(channel) {
    const key = this._channelKey(channel);
    if (!this.state.has(key)) {
      this.state.set(key, {
        baselineReady: false,
        current: new Set(),
        seenAt: new Map(),
      });
    }
    return this.state.get(key);
  }

  isReady() {
    return this.running
      && this.channels.length > 0
      && !this.disabledReason
      && this.pollErrors.size === 0
      && this.channels.every(channel => this._stateFor(channel).baselineReady);
  }

  getStatus() {
    return {
      running: this.running,
      ready: this.isReady(),
      disabledReason: this.disabledReason,
      failures: [...this.pollErrors.values()].map(failure => ({ ...failure })),
    };
  }

  observeIrcJoin(channel, username, at = this.now()) {
    const login = String(username || '').trim().toLowerCase();
    if (!login) return;
    const state = this._stateFor(channel);
    state.current.add(login);
    state.seenAt.set(login, at);
  }

  observeIrcPart(channel, username, at = this.now()) {
    const login = String(username || '').trim().toLowerCase();
    if (!login) return;
    const state = this._stateFor(channel);
    state.current.delete(login);
    // Keep seenAt so a delayed API snapshot does not duplicate a recent IRC welcome.
    state.seenAt.set(login, at);
  }

  _prune(state, now = this.now()) {
    for (const [login, at] of state.seenAt) {
      if (now - Number(at || 0) > this.rejoinSuppressMs * 2) state.seenAt.delete(login);
    }
  }

  async pollChannel(channel) {
    if (!this.helix) throw new Error('helix_unavailable');

    const channelKey = this._channelKey(channel);
    const state = this._stateFor(channelKey);
    const now = this.now();
    this._prune(state, now);

    const broadcasterLogin = channelKey.replace(/^#/, '');
    const broadcaster = await this.helix.getUserByLogin(broadcasterLogin);
    if (!broadcaster?.id) throw new Error(`broadcaster_not_found:${broadcasterLogin}`);

    const moderatorId = await this.helix.getTokenOwnerId();
    let chatters;
    try {
      chatters = await this.helix.getChatters(broadcaster.id, moderatorId);
    } catch (err) {
      err.helixOperation ||= 'get_chatters';
      throw err;
    }

    const current = new Set(
      chatters
        .map(entry => String(entry?.user_login || '').trim().toLowerCase())
        .filter(Boolean)
    );

    if (!state.baselineReady) {
      state.current = current;
      for (const login of current) state.seenAt.set(login, now);
      state.baselineReady = true;
      log.info(`Chatter baseline captured for ${channelKey}: ${current.size} chat-connected users`);
      return { baseline: true, arrivals: [] };
    }

    const arrivals = [];
    for (const login of current) {
      const recentlySeenAt = Number(state.seenAt.get(login) || 0);
      const absentLastPoll = !state.current.has(login);
      const suppressed = recentlySeenAt && now - recentlySeenAt < this.rejoinSuppressMs;

      state.seenAt.set(login, now);
      if (!absentLastPoll || suppressed) continue;
      if (!shouldWelcomeJoin({
        channel: channelKey,
        username: login,
        self: false,
        botLogin: this.botLogin,
        ignoredUsers: this.ignoredUsers,
      })) continue;

      arrivals.push(login);
      await this.onArrival({ channel: channelKey, username: login, source: 'helix-chatters' });
    }

    state.current = current;
    return { baseline: false, arrivals };
  }

  _tickResult() {
    const status = this.getStatus();
    return { ...status, ok: status.ready };
  }

  async _pollChannels() {
    if (!this.helix) {
      const error = new Error('helix_unavailable');
      log.warn('Chatter watcher poll failed', error.message);
      return this._tickResult();
    }

    for (const channel of this.channels) {
      const channelKey = this._channelKey(channel);
      try {
        await this.pollChannel(channelKey);
        if (this.pollErrors.delete(channelKey)) {
          log.info(`Chatter watcher poll recovered for ${channelKey}`);
        }
      } catch (err) {
        const status = Number(err?.response?.status || 0);
        const reason = status === 401
          ? 'twitch_unauthorized'
          : status === 403 && err.helixOperation === 'get_chatters'
            ? 'bot_not_channel_moderator'
            : 'helix_poll_failed';
        const failure = { channel: channelKey, reason, status: status || null };
        const previous = this.pollErrors.get(channelKey);
        this.pollErrors.set(channelKey, failure);

        if (status === 401) {
          this.disabledReason = reason;
          if (previous?.reason !== reason || previous.status !== status) {
            log.warn(`Chatter watcher disabled after Twitch returned 401 for ${channelKey}; verify the bot token and moderator:read:chatters scope`);
          }
          break;
        }

        if (status === 403 && err.helixOperation === 'get_chatters') {
          if (previous?.reason !== reason || previous.status !== status) {
            log.warn(`Twitch returned 403 for Get Chatters in ${channelKey}; make ${this.botLogin || 'the bot'} a channel moderator. The watcher will retry automatically.`);
          }
          continue;
        }

        if (previous?.reason !== reason || previous.status !== status) {
          log.warn(`Chatter watcher poll failed for ${channelKey}`, err?.response?.data || err.message);
        }
      }
    }

    return this._tickResult();
  }

  async _runExclusiveTick() {
    if (this.tickPromise) return this.tickPromise;
    const pending = this._pollChannels();
    this.tickPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.tickPromise === pending) this.tickPromise = null;
    }
  }

  async tick() {
    if (!this.running || this.resuming || this.disabledReason) return this._tickResult();
    return this._runExclusiveTick();
  }

  start() {
    if (this.running) return this.firstPollPromise || Promise.resolve(this._tickResult());
    this.running = true;
    this.firstPollPromise = this.tick();
    this.firstPollPromise.catch(err => log.warn('Initial chatter watcher poll failed', err.message));
    this.timer = setInterval(() => {
      this.tick().catch(err => log.warn('Chatter watcher tick failed', err.message));
    }, this.pollMs);
    this.timer.unref?.();
    log.info(`Chatter watcher started (poll=${Math.round(this.pollMs / 1000)}s)`);
    return this.firstPollPromise;
  }

  async resumeAfterAuthorization() {
    if (!this.running) return false;
    if (this.resumePromise) return this.resumePromise;

    this.resuming = true;
    const pending = (async () => {
      if (this.tickPromise) await this.tickPromise;
      if (!this.running) return false;

      this.disabledReason = null;
      this.pollErrors.clear();
      for (const state of this.state.values()) {
        state.baselineReady = false;
        state.current.clear();
        state.seenAt.clear();
      }
      log.info('Chatter watcher authorization refreshed; rebuilding baseline');
      const result = await this._runExclusiveTick();
      return result.ready;
    })();
    this.resumePromise = pending;

    try {
      return await pending;
    } finally {
      if (this.resumePromise === pending) this.resumePromise = null;
      this.resuming = false;
    }
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.state.clear();
    this.pollErrors.clear();
    this.disabledReason = null;
  }
}
