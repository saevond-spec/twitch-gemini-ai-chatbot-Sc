import WebSocket from 'ws';
import { createLogger } from '../logger/index.js';
import { config } from '../config/index.js';
import bus from '../bus/index.js';
import { HelixClient } from './helix.js';
import { getRedis } from '../storage/redis.js';
import { getAccessToken } from './auth.js';
import { metrics } from '../utils/metrics.js';

const log = createLogger('EVENTSUB');

export class EventSubClient {
  constructor() {
    this.ws = null;
    this.sessionId = null;
    this.helix = new HelixClient();
    this.broadcasterIds = new Set();
    this._reconnectTimer = null;
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 20;
    this._isDisconnecting = false;
    this._connecting = null;
    this._lastKeepalive = 0;
    this._watchdog = null;
    this._seenMessageIds = new Map();
  }

  async connect(url = null, { transferred = false } = {}) {
    if (this._connecting) return this._connecting;
    const target = url || config.eventsub.wssUrl || 'wss://eventsub.wss.twitch.tv/ws';
    if (!getAccessToken()) throw new Error('No user access token available – cannot connect to EventSub');

    this._connecting = new Promise((resolve, reject) => {
      const socket = new WebSocket(target, {
        headers: {
          'Origin': config.server.publicUrl || 'https://your-app.onrender.com',
          'User-Agent': 'SweatyClanker/3.1',
        }
      });
      const timeout = setTimeout(() => {
        try { socket.close(); } catch {}
        reject(new Error('EventSub connection timeout'));
        this._connecting = null;
      }, 15000);

      socket.on('open', () => log.info('EventSub WebSocket open, waiting for welcome...'));
      socket.on('message', data => this._handleMessage(socket, data, resolve, reject, transferred));
      socket.on('error', err => {
        clearTimeout(timeout);
        log.error('EventSub WebSocket error', err.message);
        if (socket === this.ws && !this._isDisconnecting) this._scheduleReconnect();
      });
      socket.on('close', (code, reason) => {
        clearTimeout(timeout);
        log.warn(`EventSub WebSocket closed: ${code} ${reason}`);
        if (socket === this.ws && !this._isDisconnecting) this._scheduleReconnect();
      });

      socket._welcomeTimeout = timeout;
    });
    return this._connecting;
  }

  _rememberMessage(id) {
    if (!id) return false;
    const now = Date.now();
    const expiry = now - 10 * 60 * 1000;
    for (const [key, ts] of this._seenMessageIds) if (ts < expiry) this._seenMessageIds.delete(key);
    if (this._seenMessageIds.has(id)) return true;
    this._seenMessageIds.set(id, now);
    return false;
  }

  _startWatchdog(keepaliveSeconds = 10) {
    if (this._watchdog) clearInterval(this._watchdog);
    const threshold = Math.max(15000, keepaliveSeconds * 2500);
    this._lastKeepalive = Date.now();
    this._watchdog = setInterval(() => {
      if (this._isDisconnecting || !this.ws) return;
      if (Date.now() - this._lastKeepalive > threshold) {
        log.warn('EventSub keepalive overdue; reconnecting');
        metrics.eventsubReconnects.inc();
        try { this.ws.terminate(); } catch {}
        this._scheduleReconnect();
      }
    }, Math.max(5000, keepaliveSeconds * 1000));
  }

  async _handleMessage(socket, data, resolve, reject, transferred) {
    let parsed;
    try { parsed = JSON.parse(data); }
    catch (err) { log.warn('Ignoring malformed EventSub payload'); return; }

    const { metadata = {}, payload = {} } = parsed;
    const messageId = metadata.message_id;
    if (metadata.message_type === 'notification' && this._rememberMessage(messageId)) {
      log.debug(`Ignoring duplicate EventSub message ${messageId}`);
      return;
    }

    if (metadata.message_type === 'session_welcome') {
      clearTimeout(socket._welcomeTimeout);
      const old = this.ws;
      this.ws = socket;
      this.sessionId = payload.session?.id;
      global._eventsubSessionId = this.sessionId;
      this._lastKeepalive = Date.now();
      this._startWatchdog(payload.session?.keepalive_timeout_seconds || 10);
      this._reconnectAttempts = 0;
      this._connecting = null;
      resolve();
      if (old && old !== socket) {
        old.removeAllListeners();
        try { old.close(); } catch {}
      }
      if (!transferred) {
        this._subscribeToAllEvents().catch(err => log.error('Failed to subscribe to EventSub events', err.message));
      } else {
        log.info('EventSub session transferred without duplicate subscriptions');
      }
      return;
    }

    if (socket !== this.ws) return;

    if (metadata.message_type === 'session_keepalive') {
      this._lastKeepalive = Date.now();
      return;
    }

    if (metadata.message_type === 'notification') {
      this._lastKeepalive = Date.now();
      const event = payload.event;
      const type = metadata.subscription_type;
      bus.emit(`eventsub.${type}`, event);
      bus.emit('eventsub.event', { type, event, messageId });
      if (process.env.EVENTSUB_REDIS_AUDIT === 'true') {
        const redis = getRedis();
        if (redis) redis.set(`eventsub:${messageId || Date.now()}`, JSON.stringify({ type, event }), 'EX', 3600).catch(() => {});
      }
      this._handleEvent(type, event);
      return;
    }

    if (metadata.message_type === 'session_reconnect') {
      const reconnectUrl = payload.session?.reconnect_url;
      if (!reconnectUrl) {
        this._scheduleReconnect();
        return;
      }
      metrics.eventsubReconnects.inc();
      log.info('EventSub requested session transfer');
      this._connecting = null;
      this.connect(reconnectUrl, { transferred: true }).catch(err => {
        log.error('EventSub transfer failed', err.message);
        this._scheduleReconnect();
      });
      return;
    }

    if (metadata.message_type === 'revocation') {
      log.warn(`EventSub subscription revoked: ${metadata.subscription_type || 'unknown'}`);
    }
  }

  async _subscribeToAllEvents() {
    const moderatorId = await this.helix.getTokenOwnerId();
    for (const channel of config.twitch.channels) {
      const clean = channel.replace(/^#/, '').toLowerCase();
      const user = await this.helix.getUserByLogin(clean);
      if (!user?.id) continue;
      this.broadcasterIds.add(user.id);
      const results = await Promise.allSettled([
        this.helix.subscribeFollow(user.id, moderatorId),
        this.helix.subscribeShoutout(user.id, moderatorId),
      ]);
      log.info(`EventSub ${clean}: ${results.filter(x => x.status === 'fulfilled').length}/${results.length} subscriptions active`);
    }
  }

  _handleEvent(type, event) {
    const channel = `#${event?.broadcaster_user_login || config.twitch.channels[0]?.replace(/^#/, '') || 'channel'}`;
    const templates = {
      'channel.follow': e => `Thanks for the follow, @${e.user_name}! ❤️`,
      'channel.shoutout.create': e => `Shoutout to @${e.to_broadcaster_user_name || e.recommended_user_name}! Go check them out! 📢`,
    };
    const message = templates[type]?.(event);
    if (message) bus.emit('twitch.send', { channel, message });
  }

  _scheduleReconnect() {
    if (this._isDisconnecting || this._reconnectTimer || this._connecting) return;
    this._reconnectAttempts += 1;
    const attempt = Math.min(this._reconnectAttempts, this._maxReconnectAttempts);
    const base = Math.min(1000 * 2 ** Math.min(attempt, 5), 30000);
    const delay = Math.round(base * (0.75 + Math.random() * 0.5));
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      metrics.eventsubReconnects.inc();
      this._connecting = null;
      this.connect().catch(err => {
        log.error('EventSub reconnect failed', err.message);
        this._scheduleReconnect();
      });
    }, delay);
  }

  disconnect() {
    this._isDisconnecting = true;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this._watchdog) clearInterval(this._watchdog);
    this._reconnectTimer = null;
    this._watchdog = null;
    this._connecting = null;
    if (this.ws) {
      this.ws.removeAllListeners();
      try { this.ws.close(); } catch {}
    }
    this.ws = null;
    this.sessionId = null;
    this._seenMessageIds.clear();
  }
}
