import { createLogger } from '../logger/index.js';
import { getClipDownloads } from '../clips/twitchClipService.js';
import { downloadToTemp, safeUnlink } from '../media/download.js';
import { renderVerticalShort } from '../media/clipRenderer.js';
import { uploadYouTubeVideo } from '../social/youtube.js';
import { uploadTikTokDraft } from '../social/tiktok.js';
import { announceDiscord } from '../social/discord.js';
import { PublishStore } from '../social/publishStore.js';

const log = createLogger('WORKER');

async function publishOnce(platform, clipId, fn) {
  const reserved = await PublishStore.reserve(platform, clipId);
  if (!reserved) {
    const existing = await PublishStore.get(platform, clipId);
    log.info(`Skipping duplicate ${platform} publish for ${clipId}`);
    return existing?.result || { skipped: true };
  }
  try {
    const result = await fn();
    await PublishStore.complete(platform, clipId, result);
    return result;
  } catch (error) {
    await PublishStore.fail(platform, clipId, error);
    throw error;
  }
}

async function publishSocial({ clipId, filePath, title, reason, twitchUrl }) {
  const results = {};

  if (process.env.YOUTUBE_UPLOAD_ENABLED === 'true') {
    results.youtube = await publishOnce('youtube', clipId, () => uploadYouTubeVideo({
      filePath,
      title,
      description: [reason, twitchUrl].filter(Boolean).join('\n\n'),
      privacyStatus: process.env.YOUTUBE_DEFAULT_PRIVACY || 'private',
    }));
  }

  if (process.env.TIKTOK_UPLOAD_ENABLED === 'true') {
    results.tiktok = await publishOnce('tiktok', clipId, () => uploadTikTokDraft({ filePath }));
  }

  if (process.env.DISCORD_ANNOUNCE_ENABLED === 'true') {
    results.discord = await publishOnce('discord', clipId, () => announceDiscord({
      title,
      twitchUrl,
      youtubeUrl: results.youtube?.url || null,
    }));
  }

  return results;
}

async function processOfficialTwitchClip(data) {
  const { clipId, broadcasterId, title, reason, twitchUrl } = data;
  if (!clipId || !broadcasterId) throw new Error('generate-clips requires clipId and broadcasterId');

  const downloads = await getClipDownloads({ broadcasterId, clipId });
  const portraitUrl = downloads.portrait_download_url || null;
  const landscapeUrl = downloads.landscape_download_url || null;
  const sourceUrl = portraitUrl || landscapeUrl;
  if (!sourceUrl) throw new Error(`Twitch returned no downloadable media for clip ${clipId}`);

  let sourcePath = null;
  let finalPath = null;
  try {
    sourcePath = await downloadToTemp(sourceUrl);
    finalPath = portraitUrl ? sourcePath : await renderVerticalShort(sourcePath);
    const result = await publishSocial({ clipId, filePath: finalPath, title, reason, twitchUrl });
    log.info(`Completed clip pipeline for ${clipId}`);
    return result;
  } finally {
    if (finalPath && finalPath !== sourcePath) await safeUnlink(finalPath);
    await safeUnlink(sourcePath);
  }
}

export const jobHandlers = {
  'generate-clips': processOfficialTwitchClip,

  'post-social': async ({ clipId, filePath, title, reason, twitchUrl }) => {
    if (!clipId || !filePath) throw new Error('post-social requires clipId and filePath');
    return publishSocial({ clipId, filePath, title, reason, twitchUrl });
  },

  'discord-announce': async ({ clipId, title, twitchUrl, youtubeUrl }) => {
    if (!clipId) throw new Error('discord-announce requires clipId');
    return publishOnce('discord', clipId, () => announceDiscord({ title, twitchUrl, youtubeUrl }));
  },

  'moderation-review': async ({ channel, user, message, reason, riskScore }) => {
    log.info('Moderation review requested', { channel, user, message, reason, riskScore });
  },
};
