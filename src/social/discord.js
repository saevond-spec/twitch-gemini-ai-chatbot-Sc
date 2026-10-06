import axios from 'axios';

export async function announceDiscord({ title, twitchUrl, youtubeUrl }) {
  if (process.env.DISCORD_ANNOUNCE_ENABLED !== 'true') {
    throw new Error('Discord announcements are disabled');
  }
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) throw new Error('DISCORD_WEBHOOK_URL is not configured');

  const lines = [`**${String(title || 'New highlight').slice(0, 200)}**`];
  if (youtubeUrl) lines.push(youtubeUrl);
  if (twitchUrl && twitchUrl !== youtubeUrl) lines.push(twitchUrl);

  await axios.post(webhook, { content: lines.join('\n') }, { timeout: 15000 });
  return { announced: true };
}
