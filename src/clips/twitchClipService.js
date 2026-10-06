import axios from 'axios';
import { config } from '../config/index.js';
import { getAccessToken, getAuthenticatedUserId } from '../twitch/auth.js';
import { createLogger } from '../logger/index.js';

const log = createLogger('CLIP');
const HELIX = 'https://api.twitch.tv/helix';

function headers() {
  const token = getAccessToken();
  if (!token) throw new Error('Twitch authorization required');
  return { Authorization: `Bearer ${token}`, 'Client-Id': config.twitch.clientId };
}

async function helixPost(path, params) {
  const response = await axios.post(`${HELIX}${path}`, null, { params, headers: headers(), timeout: 15000 });
  return response.data?.data || [];
}

async function helixGet(path, params) {
  const response = await axios.get(`${HELIX}${path}`, { params, headers: headers(), timeout: 15000 });
  return response.data?.data || [];
}

export async function createClipFromVod({ broadcasterId, vodId, endSeconds, durationSeconds, title }) {
  const duration = Math.max(5, Math.min(60, Number(durationSeconds) || 30));
  const editorId = getAuthenticatedUserId();
  if (!editorId) throw new Error('Authenticated Twitch editor id is unavailable; reconnect Twitch');
  const [clip] = await helixPost('/videos/clips', {
    editor_id: editorId,
    broadcaster_id: broadcasterId,
    vod_id: vodId,
    vod_offset: Math.max(Math.ceil(duration), Math.round(endSeconds)),
    duration,
    title: String(title || 'SweatyClanker highlight').slice(0, 100),
  });
  if (!clip?.id) throw new Error('Twitch did not return a clip id');

  for (let i = 0; i < 12; i += 1) {
    if (i) await new Promise(r => setTimeout(r, 5000));
    const [ready] = await helixGet('/clips', { id: clip.id });
    if (ready) {
      log.info(`Twitch clip ready: ${clip.id}`);
      return { ...ready, edit_url: clip.edit_url };
    }
  }
  throw new Error(`Twitch clip ${clip.id} was not ready after 60 seconds`);
}

export async function getClipDownloads({ broadcasterId, clipId }) {
  const editorId = getAuthenticatedUserId();
  if (!editorId) throw new Error('Authenticated Twitch editor id is unavailable; reconnect Twitch');
  const [download] = await helixGet('/clips/downloads', {
    editor_id: editorId,
    broadcaster_id: broadcasterId,
    clip_id: clipId,
  });
  if (!download) throw new Error(`No Twitch download URL returned for clip ${clipId}`);
  return download;
}
