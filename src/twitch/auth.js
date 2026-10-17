import axios from 'axios';
import { config } from '../config/index.js';
import { getRedis } from '../storage/redis.js';
import { readJSON, writeJSON } from '../storage/file.js';
import { createLogger } from '../logger/index.js';

const log = createLogger('AUTH');
const TOKEN_KEY = 'twitch:oauth:bot';
const LEGACY_TOKEN_KEY = 'twitch:oauth';
const TOKEN_FILE = './tokens.bot.json';
const LEGACY_TOKEN_FILE = './tokens.json';
const REQUEST_TIMEOUT_MS = 10000;

let currentToken = null;
let refreshTimer = null;
let refreshPromise = null;

export const BOT_SCOPES = [
  'chat:read', 'chat:edit',
  'user:bot', 'user:read:chat', 'user:write:chat',
  'moderation:read', 'channel:manage:moderators',
  'moderator:read:followers',
  'moderator:manage:shoutouts',
  'channel:manage:clips',
];

export function configuredBotLogin() {
  return String(config.twitch.username || '').trim().toLowerCase();
}

export function tokenBelongsToConfiguredBot(validation = {}) {
  const expected = configuredBotLogin();
  const actual = String(validation?.login || '').trim().toLowerCase();
  return Boolean(expected && actual && expected === actual);
}

async function validateAccessToken(accessToken) {
  if (!accessToken) throw new Error('Missing Twitch access token');
  const response = await axios.get('https://id.twitch.tv/oauth2/validate', {
    headers: { Authorization: `OAuth ${accessToken}` },
    timeout: REQUEST_TIMEOUT_MS,
  });
  return response.data || {};
}

async function revokeAccessToken(accessToken) {
  if (!accessToken) return;
  try {
    const params = new URLSearchParams({
      client_id: config.twitch.clientId,
      token: accessToken,
    });
    await axios.post(
      'https://id.twitch.tv/oauth2/revoke',
      params.toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: REQUEST_TIMEOUT_MS,
      },
    );
  } catch (err) {
    log.warn('Unable to revoke rejected Twitch access token', err.response?.status || err.message);
  }
}

async function clearStoredToken({ legacy = false } = {}) {
  const redis = getRedis();
  const key = legacy ? LEGACY_TOKEN_KEY : TOKEN_KEY;
  const file = legacy ? LEGACY_TOKEN_FILE : TOKEN_FILE;
  try {
    if (redis) await redis.del(key);
  } catch (err) {
    log.warn(`Failed to clear ${legacy ? 'legacy ' : ''}Twitch token from Redis`, err.message);
  }
  try {
    await writeJSON(file, null);
  } catch (err) {
    log.warn(`Failed to clear ${legacy ? 'legacy ' : ''}Twitch token file`, err.message);
  }
}

async function loadStoredToken() {
  const redis = getRedis();
  if (redis) {
    try {
      const data = await redis.get(TOKEN_KEY);
      if (data) return JSON.parse(data);
    } catch (err) {
      log.warn('Failed to load bot token from Redis', err.message);
    }
  }
  return readJSON(TOKEN_FILE, null);
}

async function loadLegacyToken() {
  const redis = getRedis();
  if (redis) {
    try {
      const data = await redis.get(LEGACY_TOKEN_KEY);
      if (data) return JSON.parse(data);
    } catch (err) {
      log.warn('Failed to inspect legacy Twitch token', err.message);
    }
  }
  return readJSON(LEGACY_TOKEN_FILE, null);
}

async function saveToken(tokenData) {
  const redis = getRedis();
  const expiresIn = tokenData.expires_in || 86400;
  if (redis) {
    try {
      await redis.set(TOKEN_KEY, JSON.stringify(tokenData), 'EX', expiresIn);
      log.debug('Bot token persisted to Redis');
    } catch (err) {
      log.warn('Failed to save bot token to Redis', err.message);
    }
  }
  try {
    await writeJSON(TOKEN_FILE, tokenData);
    log.debug('Bot token persisted to file');
  } catch (err) {
    log.warn('Failed to save bot token to file', err.message);
  }
}

async function migrateOrRejectLegacyToken() {
  const legacy = await loadLegacyToken();
  if (!legacy?.access_token) return false;

  try {
    const validation = await validateAccessToken(legacy.access_token);
    if (!tokenBelongsToConfiguredBot(validation)) {
      log.error(
        `Legacy Twitch token belongs to "${validation.login || 'unknown'}", not configured bot "${configuredBotLogin()}". Revoking it and refusing chat startup.`,
      );
      await revokeAccessToken(legacy.access_token);
      await clearStoredToken({ legacy: true });
      return false;
    }

    const granted = new Set(validation.scopes || []);
    const missing = BOT_SCOPES.filter(scope => !granted.has(scope));
    if (missing.length) {
      log.info('Legacy token belongs to the bot account but needs updated scopes; clearing it for re-authorization.');
      await clearStoredToken({ legacy: true });
      return false;
    }

    const migrated = {
      ...legacy,
      user_id: validation.user_id,
      login: validation.login,
      scopes: [...granted],
    };
    await saveToken(migrated);
    await clearStoredToken({ legacy: true });
    currentToken = migrated;
    log.info(`Migrated verified bot token for ${validation.login} to bot-only storage`);
    return true;
  } catch (err) {
    log.warn('Legacy Twitch token is invalid; clearing it', err.response?.status || err.message);
    await clearStoredToken({ legacy: true });
    return false;
  }
}

export async function validateToken() {
  if (!currentToken) return false;
  try {
    const validation = await validateAccessToken(currentToken.access_token);

    if (!tokenBelongsToConfiguredBot(validation)) {
      log.error(
        `Twitch identity mismatch: expected bot "${configuredBotLogin()}", token belongs to "${validation.login || 'unknown'}". Revoking token and stopping bot auth.`,
      );
      await revokeAccessToken(currentToken.access_token);
      await clearStoredToken();
      currentToken = null;
      return false;
    }

    const granted = new Set(validation.scopes || []);
    const missingScopes = BOT_SCOPES.filter(scope => !granted.has(scope));
    if (missingScopes.length) {
      log.warn(`Bot Twitch token is missing required scopes: ${missingScopes.join(', ')}. Re-authorization required.`);
      return false;
    }

    currentToken.scopes = [...granted];
    currentToken.user_id = validation.user_id || currentToken.user_id;
    currentToken.login = validation.login || currentToken.login;
    return true;
  } catch (err) {
    log.debug('Bot token validation failed', err.response?.status || err.message);
    return false;
  }
}

export async function initAuth() {
  let stored = await loadStoredToken();

  if (!stored) {
    const migrated = await migrateOrRejectLegacyToken();
    if (migrated) stored = currentToken;
  }

  if (stored) {
    currentToken = stored;
    log.info('Bot token loaded from bot-only storage');

    const valid = await validateToken();
    if (!valid) {
      if (!currentToken) return false;
      log.warn('Stored bot token invalid, attempting refresh...');
      try {
        await refreshToken();
        if (currentToken && await validateToken()) {
          scheduleRefresh();
          return true;
        }
      } catch (err) {
        log.error('Bot token refresh failed, auth not ready');
      }
      currentToken = null;
      return false;
    }

    if (currentToken.expires_at && Date.now() >= currentToken.expires_at - 60000) {
      log.info('Bot token near expiry, refreshing...');
      await refreshToken().catch(() => log.error('Pre-emptive bot token refresh failed'));
    }
    scheduleRefresh();
    return true;
  }

  log.info(`No verified ${configuredBotLogin()} bot token yet – waiting for OAuth`);
  return false;
}

export async function exchangeCodeForToken(code, redirectUri) {
  const params = new URLSearchParams({
    client_id: config.twitch.clientId,
    client_secret: config.twitch.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });

  const response = await axios.post(
    'https://id.twitch.tv/oauth2/token',
    params.toString(),
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: REQUEST_TIMEOUT_MS,
    },
  );

  const tokenData = response.data;
  const validation = await validateAccessToken(tokenData.access_token);

  if (!tokenBelongsToConfiguredBot(validation)) {
    await revokeAccessToken(tokenData.access_token);
    throw new Error(
      `Wrong Twitch account authorized. Expected "${configuredBotLogin()}" but Twitch returned "${validation.login || 'unknown'}". Log into the SweatyClanker Twitch account and try again.`,
    );
  }

  const granted = new Set(validation.scopes || []);
  const missingScopes = BOT_SCOPES.filter(scope => !granted.has(scope));
  if (missingScopes.length) {
    await revokeAccessToken(tokenData.access_token);
    throw new Error(`Twitch authorization missing bot scopes: ${missingScopes.join(', ')}`);
  }

  tokenData.expires_at = Date.now() + tokenData.expires_in * 1000;
  tokenData.scopes = [...granted];
  tokenData.user_id = validation.user_id;
  tokenData.login = validation.login;

  currentToken = tokenData;
  await saveToken(tokenData);
  scheduleRefresh();
  log.info(`Bot authorization completed for verified Twitch account: ${validation.login}`);
  return tokenData;
}

async function refreshToken() {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    if (!currentToken) return;

    const params = new URLSearchParams({
      client_id: config.twitch.clientId,
      client_secret: config.twitch.clientSecret,
      refresh_token: currentToken.refresh_token,
      grant_type: 'refresh_token',
    });

    try {
      const response = await axios.post(
        'https://id.twitch.tv/oauth2/token',
        params.toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: REQUEST_TIMEOUT_MS,
        },
      );

      const newData = response.data;
      if (newData.refresh_token) currentToken.refresh_token = newData.refresh_token;
      currentToken.access_token = newData.access_token;
      currentToken.expires_in = newData.expires_in;
      currentToken.expires_at = Date.now() + newData.expires_in * 1000;

      const validation = await validateAccessToken(currentToken.access_token);
      if (!tokenBelongsToConfiguredBot(validation)) {
        await revokeAccessToken(currentToken.access_token);
        await clearStoredToken();
        currentToken = null;
        throw new Error('bot_identity_mismatch');
      }

      currentToken.user_id = validation.user_id;
      currentToken.login = validation.login;
      currentToken.scopes = validation.scopes || currentToken.scopes;
      await saveToken(currentToken);
      log.info(`Bot token refreshed successfully for ${validation.login}`);
    } catch (err) {
      const status = err.response?.status;
      const errorCode = err.response?.data?.error;
      if ((status === 400 && errorCode === 'invalid_grant') || err.message === 'bot_identity_mismatch') {
        log.error('Bot refresh token invalid/revoked or identity mismatched – manual bot re-authorization required');
        currentToken = null;
        await clearStoredToken();
        throw err;
      }
      log.warn('Bot token refresh failed (transient)', err.response?.status || err.message);
      scheduleRefresh();
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  if (!currentToken || !currentToken.expires_at) return;
  const timeToExpiry = currentToken.expires_at - Date.now();
  const refreshAt = Math.max(timeToExpiry - 60000, 60000);
  refreshTimer = setTimeout(async () => {
    try {
      await refreshToken();
    } catch (err) {
      if (err.message === 'invalid_grant' || err.message === 'bot_identity_mismatch') return;
    }
    scheduleRefresh();
  }, refreshAt);
}

export function getAccessToken() {
  return currentToken?.access_token || null;
}

export function getAuthenticatedUserId() {
  return currentToken?.user_id || null;
}

export function getAuthenticatedLogin() {
  return currentToken?.login || null;
}

export function isAuthorized() {
  return Boolean(currentToken?.access_token && currentToken?.login === configuredBotLogin());
}
