import axios from 'axios';
import { createHash, randomBytes, verify } from 'crypto';
import { getRedis } from '../storage/redis.js';

const API_BASE = 'https://api.kick.com/public/v1';
const OAUTH_BASE = 'https://id.kick.com';
const TOKEN_KEY = 'kick:oauth:tokens';
const STATE_PREFIX = 'kick:oauth:state:';
const SEEN_PREFIX = 'kick:webhook:seen:';

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function normalizeKickChatEvent(payload = {}) {
  const broadcaster = payload.broadcaster || {};
  const sender = payload.sender || {};
  const badges = sender.identity?.badges || [];
  return {
    platform: 'kick',
    channel: String(broadcaster.channel_slug || broadcaster.username || broadcaster.user_id || '').toLowerCase(),
    broadcasterUserId: broadcaster.user_id ?? payload.broadcaster_user_id ?? null,
    user: {
      id: sender.user_id != null ? String(sender.user_id) : '',
      username: String(sender.channel_slug || sender.username || 'viewer').toLowerCase(),
      'display-name': sender.username || sender.channel_slug || 'viewer',
      badges: Object.fromEntries(badges.map((b) => [String(b.type || b.text || 'badge').toLowerCase(), '1'])),
      mod: badges.some((b) => /mod/i.test(String(b.type || b.text || ''))),
      platform: 'kick',
      messageId: payload.message_id || null,
    },
    message: String(payload.content || ''),
    self: false,
    raw: payload,
  };
}

export class KickChatClient {
  constructor({ clientId, clientSecret, publicUrl, logger }) {
    this.clientId = String(clientId || '').trim();
    this.clientSecret = String(clientSecret || '').trim();
    this.publicUrl = String(publicUrl || '').replace(/\/$/, '');
    this.log = logger;
    this.tokens = null;
    this.publicKey = null;
    this.publicKeyFetchedAt = 0;
  }

  get configured() {
    return Boolean(this.clientId && this.clientSecret && this.publicUrl);
  }

  async init() {
    if (!this.configured) return false;
    const redis = getRedis();
    if (redis) {
      const saved = await redis.get(TOKEN_KEY);
      if (saved) {
        try { this.tokens = JSON.parse(saved); } catch {}
      }
    }
    if (!this.tokens?.access_token && process.env.KICK_ACCESS_TOKEN) {
      this.tokens = {
        access_token: process.env.KICK_ACCESS_TOKEN,
        refresh_token: process.env.KICK_REFRESH_TOKEN || '',
        expires_at: Number(process.env.KICK_TOKEN_EXPIRES_AT || 0),
      };
    }
    return Boolean(this.tokens?.access_token);
  }

  async saveTokens(tokenResponse) {
    const now = Date.now();
    this.tokens = {
      ...this.tokens,
      ...tokenResponse,
      expires_at: tokenResponse.expires_in ? now + Number(tokenResponse.expires_in) * 1000 : this.tokens?.expires_at || 0,
    };
    const redis = getRedis();
    if (redis) await redis.set(TOKEN_KEY, JSON.stringify(this.tokens));
  }

  async beginOAuth() {
    if (!this.configured) throw new Error('Kick integration is not configured');
    const state = randomBytes(24).toString('hex');
    const verifier = base64url(randomBytes(48));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    const redis = getRedis();
    const packed = JSON.stringify({ verifier, createdAt: Date.now() });
    if (redis) await redis.set(`${STATE_PREFIX}${state}`, packed, 'EX', 600);
    else global.__kickOauthStates = new Map([...(global.__kickOauthStates || []), [state, packed]]);

    const redirectUri = `${this.publicUrl}/auth/kick/callback`;
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: redirectUri,
      scope: 'user:read chat:write events:subscribe',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return `${OAUTH_BASE}/oauth/authorize?${params.toString()}`;
  }

  async completeOAuth(code, state) {
    const redis = getRedis();
    let packed;
    if (redis) {
      packed = await redis.get(`${STATE_PREFIX}${state}`);
      if (packed) await redis.del(`${STATE_PREFIX}${state}`);
    } else {
      packed = global.__kickOauthStates?.get(state);
      global.__kickOauthStates?.delete(state);
    }
    if (!packed) throw new Error('Invalid or expired Kick OAuth state');
    const { verifier } = JSON.parse(packed);
    const redirectUri = `${this.publicUrl}/auth/kick/callback`;
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    const { data } = await axios.post(`${OAUTH_BASE}/oauth/token`, body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    });
    await this.saveTokens(data);
    const user = await this.getCurrentUser();
    const broadcasterUserId = user?.user_id ?? user?.id;
    if (broadcasterUserId) await this.ensureChatSubscription(broadcasterUserId);
    return user;
  }

  async refreshIfNeeded() {
    if (!this.tokens?.access_token) throw new Error('Kick is not authorized');
    if (!this.tokens.expires_at || Date.now() < this.tokens.expires_at - 120000) return;
    if (!this.tokens.refresh_token) throw new Error('Kick token expired and no refresh token is available');
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.tokens.refresh_token,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
    const { data } = await axios.post(`${OAUTH_BASE}/oauth/token`, body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    });
    await this.saveTokens(data);
  }

  async api(method, path, { data, params } = {}) {
    await this.refreshIfNeeded();
    try {
      return await axios({
        method,
        url: `${API_BASE}${path}`,
        data,
        params,
        headers: { Authorization: `Bearer ${this.tokens.access_token}`, 'Content-Type': 'application/json' },
        timeout: 10000,
      });
    } catch (err) {
      if (err.response?.status === 401 && this.tokens?.refresh_token) {
        this.tokens.expires_at = 0;
        await this.refreshIfNeeded();
        return axios({
          method,
          url: `${API_BASE}${path}`,
          data,
          params,
          headers: { Authorization: `Bearer ${this.tokens.access_token}`, 'Content-Type': 'application/json' },
          timeout: 10000,
        });
      }
      throw err;
    }
  }

  async getCurrentUser() {
    const { data } = await this.api('get', '/users');
    return Array.isArray(data?.data) ? data.data[0] : data?.data || data;
  }

  async ensureChatSubscription(broadcasterUserId) {
    const body = {
      broadcaster_user_id: Number(broadcasterUserId),
      method: 'webhook',
      events: [{ name: 'chat.message.sent', version: 1 }],
    };
    const { data } = await this.api('post', '/events/subscriptions', { data: body });
    return data;
  }

  async sendMessage(broadcasterUserId, content, replyToMessageId = null) {
    const body = {
      broadcaster_user_id: Number(broadcasterUserId),
      content: String(content).slice(0, 500),
      type: 'bot',
    };
    if (replyToMessageId) body.reply_to_message_id = replyToMessageId;
    const { data } = await this.api('post', '/chat', { data: body });
    return data;
  }

  async fetchPublicKey() {
    if (this.publicKey && Date.now() - this.publicKeyFetchedAt < 3600000) return this.publicKey;
    const { data } = await axios.get(`${API_BASE}/public-key`, { timeout: 10000 });
    const key = data?.data?.public_key || data?.public_key || data?.data || data;
    if (typeof key !== 'string' || !key.includes('PUBLIC KEY')) throw new Error('Kick public key response was invalid');
    this.publicKey = key;
    this.publicKeyFetchedAt = Date.now();
    return key;
  }

  async verifyWebhook(headers, rawBody) {
    const messageId = headers['kick-event-message-id'];
    const timestamp = headers['kick-event-message-timestamp'];
    const signature = headers['kick-event-signature'];
    if (!messageId || !timestamp || !signature) return false;
    const eventTime = Date.parse(timestamp);
    if (!Number.isFinite(eventTime) || Math.abs(Date.now() - eventTime) > 10 * 60 * 1000) return false;

    const redis = getRedis();
    if (redis && await redis.get(`${SEEN_PREFIX}${messageId}`)) return false;

    const key = await this.fetchPublicKey();
    const signed = Buffer.from(`${messageId}.${timestamp}.${rawBody.toString('utf8')}`);
    const ok = verify('RSA-SHA256', signed, key, Buffer.from(signature, 'base64'));
    if (ok && redis) await redis.set(`${SEEN_PREFIX}${messageId}`, '1', 'EX', 86400);
    return ok;
  }

  getStatus() {
    return {
      configured: this.configured,
      authorized: Boolean(this.tokens?.access_token),
      expiresAt: this.tokens?.expires_at || null,
      webhookUrl: this.configured ? `${this.publicUrl}/api/kick/webhook` : null,
    };
  }
}
