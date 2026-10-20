
import axios from 'axios';
import { getAccessToken } from './auth.js';
import { createLogger } from '../logger/index.js';
const log = createLogger('HELIX');

export class HelixClient {
  constructor() {
    this.baseURL = 'https://api.twitch.tv/helix';
    this._tokenOwnerId = null;
  }

  async getHeaders() {
    const token = getAccessToken();
    if (!token) throw new Error('No access token available');
    return {
      'Authorization': `Bearer ${token}`,
      'Client-Id': process.env.TWITCH_CLIENT_ID,
    };
  }

  async getTokenOwnerId() {
    if (this._tokenOwnerId) return this._tokenOwnerId;
    const headers = await this.getHeaders();
    const res = await axios.get(`${this.baseURL}/users`, { headers });
    this._tokenOwnerId = res.data.data[0]?.id;
    if (!this._tokenOwnerId) throw new Error('Failed to get token owner ID');
    return this._tokenOwnerId;
  }

  async getUserByLogin(login) {
    const headers = await this.getHeaders();
    const res = await axios.get(`${this.baseURL}/users?login=${login}`, { headers });
    return res.data.data[0];
  }

  async getChannelInfo(broadcasterId) {
    const headers = await this.getHeaders();
    const res = await axios.get(`${this.baseURL}/channels?broadcaster_id=${broadcasterId}`, { headers });
    return res.data.data[0];
  }


  async getChatters(broadcasterId, moderatorId, { maxPages = 10 } = {}) {
    const headers = await this.getHeaders();
    const chatters = [];
    let after = null;
    let page = 0;

    do {
      const params = new URLSearchParams({
        broadcaster_id: broadcasterId,
        moderator_id: moderatorId,
        first: '1000',
      });
      if (after) params.set('after', after);

      const res = await axios.get(`${this.baseURL}/chat/chatters?${params.toString()}`, { headers });
      chatters.push(...(res.data?.data || []));
      after = res.data?.pagination?.cursor || null;
      page += 1;
    } while (after && page < maxPages);

    return chatters;
  }

  async createEventSubSubscription(type, version, condition, transport) {
    const headers = await this.getHeaders();
    const body = { type, version, condition, transport };
    try {
      const res = await axios.post(`${this.baseURL}/eventsub/subscriptions`, body, { headers });
      log.info(`EventSub subscription created for ${type}`);
      return res.data;
    } catch (err) {
      log.error(`Failed to create subscription for ${type}`, err.response?.data || err.message);
      throw err;
    }
  }

  async subscribeFollow(broadcasterId, moderatorId) {
    return this.createEventSubSubscription(
      'channel.follow',
      '2',
      { broadcaster_user_id: broadcasterId, moderator_user_id: moderatorId },
      { method: 'websocket', session_id: global._eventsubSessionId }
    );
  }

  async subscribeChannelSubscribe(broadcasterId) {
    return this.createEventSubSubscription(
      'channel.subscribe',
      '1',
      { broadcaster_user_id: broadcasterId },
      { method: 'websocket', session_id: global._eventsubSessionId }
    );
  }

  async subscribeSubscriptionGift(broadcasterId) {
    return this.createEventSubSubscription(
      'channel.subscription.gift',
      '1',
      { broadcaster_user_id: broadcasterId },
      { method: 'websocket', session_id: global._eventsubSessionId }
    );
  }

  async subscribeBitsUse(broadcasterId) {
    return this.createEventSubSubscription(
      'channel.bits.use',
      '1',
      { broadcaster_user_id: broadcasterId },
      { method: 'websocket', session_id: global._eventsubSessionId }
    );
  }

  async subscribeShoutout(broadcasterId, moderatorId) {
    return this.createEventSubSubscription(
      'channel.shoutout.create',
      '1',
      { broadcaster_user_id: broadcasterId, moderator_user_id: moderatorId },
      { method: 'websocket', session_id: global._eventsubSessionId }
    );
  }
}
