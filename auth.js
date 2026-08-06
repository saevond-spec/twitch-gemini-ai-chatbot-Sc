// src/twitch/auth.js
import axios from 'axios';
import { config } from '../config/index.js';
import { getRedis } from '../storage/redis.js';
import { readJSON, writeJSON } from '../storage/file.js';
import { createLogger } from '../logger/index.js';

const log = createLogger('AUTH');
const TOKEN_KEY = 'twitch:oauth';
const TOKEN_FILE = './tokens.json';

let currentToken = null;
let refreshTimer = null;

// Expanded scopes for modern Twitch features
const SCOPES = [
  'chat:read', 'chat:edit',
  'user:bot', 'user:read:chat', 'user:write:chat',
  'moderation:read', 'channel:manage:moderators',
  'channel:read:subscriptions', 'channel:read:redemptions',
  'channel:manage:predictions', 'channel:manage:polls',
  'bits:read', 'channel:read:hype_train',
  'channel:manage:raids', 'channel:read:goals',
  'channel:read:guest_star', 'channel:manage:shoutouts'
];

async function loadStoredToken() {
  const redis = getRedis();
  if (redis) {
    const data = await redis.get(TOKEN_KEY);
    if (data) return JSON.parse(data);
  }
  return readJSON(TOKEN_FILE, null);
}

async function saveToken(tokenData) {
  const redis = getRedis();
  if (redis) {
    await redis.set(TOKEN_KEY, JSON.stringify(tokenData), 'EX', tokenData.expires_in || 86400);
  }
  await writeJSON(TOKEN_FILE, tokenData);
}

export async function validateToken() {
  if (!currentToken) return false;
  try {
    await axios.get('https://id.twitch.tv/oauth2/validate', {
      headers: { Authorization: `OAuth ${currentToken.access_token}` }
    });
    return true;
  } catch {
    return false;
  }
}

export async function initAuth() {
  const stored = await loadStoredToken();
  if (stored) {
    currentToken = stored;
    log.info('Token loaded from storage');
    if (currentToken.expires_at && Date.now() >= currentToken.expires_at - 60000) {
      log.info('Token near expiry, refreshing...');
      await refreshToken();
    }
    const valid = await validateToken();
    if (!valid) {
      log.warn('Token invalid, will refresh on next call');
    }
    scheduleRefresh();
  }
  return !!currentToken;
}

export async function exchangeCodeForToken(code, redirectUri) {
  const response = await axios.post(
    'https://id.twitch.tv/oauth2/token',
    null,
    {
      params: {
        client_id: config.twitch.clientId,
        client_secret: config.twitch.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      },
    }
  );
  const tokenData = response.data;
  tokenData.expires_at = Date.now() + tokenData.expires_in * 1000;
  tokenData.scopes = SCOPES;
  currentToken = tokenData;
  await saveToken(tokenData);
  scheduleRefresh();
  log.info('Token exchanged successfully');
  return tokenData;
}

async function refreshToken() {
  if (!currentToken) return;
  try {
    const response = await axios.post(
      'https://id.twitch.tv/oauth2/token',
      null,
      {
        params: {
          client_id: config.twitch.clientId,
          client_secret: config.twitch.clientSecret,
          refresh_token: currentToken.refresh_token,
          grant_type: 'refresh_token',
        },
      }
    );
    const newData = response.data;
    newData.expires_at = Date.now() + newData.expires_in * 1000;
    newData.scopes = SCOPES;
    currentToken = newData;
    await saveToken(newData);
    log.info('Token refreshed');
  } catch (err) {
    log.error('Token refresh failed', err);
  }
}

function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  if (!currentToken || !currentToken.expires_at) return;
  const now = Date.now();
  const timeToExpiry = currentToken.expires_at - now;
  const refreshAt = Math.max(timeToExpiry - 60000, 60000);
  refreshTimer = setTimeout(async () => {
    await refreshToken();
    scheduleRefresh();
  }, refreshAt);
}

export function getAccessToken() {
  return currentToken?.access_token || null;
}

export function isAuthorized() {
  return !!getAccessToken();
}
