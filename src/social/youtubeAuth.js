import axios from 'axios';
import { getRedis } from '../storage/redis.js';

const TOKEN_KEY = 'youtube:oauth';
const SCOPES = ['https://www.googleapis.com/auth/youtube.upload'];

export function youtubeAuthUrl({ state, redirectUri }) {
  if (!process.env.YOUTUBE_CLIENT_ID) throw new Error('YOUTUBE_CLIENT_ID is not configured');
  const params = new URLSearchParams({
    client_id: process.env.YOUTUBE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function saveToken(token) {
  const redis = getRedis();
  if (!redis) throw new Error('Redis is required for YouTube OAuth token storage');
  const current = await loadToken();
  const merged = { ...current, ...token };
  if (token.expires_in) merged.expires_at = Date.now() + Number(token.expires_in) * 1000;
  await redis.set(TOKEN_KEY, JSON.stringify(merged));
  return merged;
}

export async function loadToken() {
  const redis = getRedis();
  if (!redis) return null;
  const raw = await redis.get(TOKEN_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function exchangeYouTubeCode({ code, redirectUri }) {
  const body = new URLSearchParams({
    client_id: process.env.YOUTUBE_CLIENT_ID || '',
    client_secret: process.env.YOUTUBE_CLIENT_SECRET || '',
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });
  const response = await axios.post('https://oauth2.googleapis.com/token', body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000,
  });
  return saveToken(response.data);
}

export async function getYouTubeAccessToken() {
  const token = await loadToken();
  if (!token) throw new Error('YouTube is not authorized');
  if (token.access_token && token.expires_at && token.expires_at > Date.now() + 60000) {
    return token.access_token;
  }
  if (!token.refresh_token) throw new Error('YouTube refresh token is missing; reconnect YouTube');
  const body = new URLSearchParams({
    client_id: process.env.YOUTUBE_CLIENT_ID || '',
    client_secret: process.env.YOUTUBE_CLIENT_SECRET || '',
    refresh_token: token.refresh_token,
    grant_type: 'refresh_token',
  });
  const response = await axios.post('https://oauth2.googleapis.com/token', body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000,
  });
  const updated = await saveToken(response.data);
  return updated.access_token;
}
