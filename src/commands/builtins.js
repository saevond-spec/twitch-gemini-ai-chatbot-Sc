
import { registerBuiltin } from './index.js';
import { brains, defaultBrain } from '../brains/index.js';
import { getRedis } from '../storage/redis.js';
import { formatSupportMessage } from '../chat/supportMessage.js';
import { suggestGameModes } from '../chat/gameModeSuggestions.js';
import { config } from '../config/index.js';
import { handleMusicCommand, handleSkipCommand, handleSongCommand } from '../music/player.js';

registerBuiltin('!help', async (user, channel, client) => {
  const brainList = Object.keys(brains).join(', ');
  return 'Commands: !help, !uptime, !bot, !about, !brain <' + brainList + '>, !clip [title], !mode, !support, !commands, !play, !music [club|dubstep|play|pause], !skip, ' + config.media.musicCommand + ', and custom commands.';
}, 'Shows this help');

registerBuiltin('!support', async (user, channel) => {
  return formatSupportMessage(channel);
}, 'Shows optional ways to support the channel');

registerBuiltin('!uptime', async (user, channel, client) => {
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  return "I've been online for " + hours + 'h ' + minutes + 'm.';
}, 'Shows bot uptime');

registerBuiltin('!bot', async () => {
  return "I'm SweatyClanker, a multi‑brain AI bot powered by DeepSeek!";
}, 'About the bot');

registerBuiltin('!about', async () => {
  return 'I use DeepSeek AI with multiple brains. Source: https://github.com/your/repo';
}, 'About the project');

registerBuiltin('!brain', async (user, channel, client, message) => {
  const parts = message.split(' ');
  if (parts.length < 2) {
    return 'Current brain: default. Available: ' + Object.keys(brains).join(', ');
  }
  const requested = parts[1].toLowerCase();
  if (brains[requested]) {
    const redis = getRedis();
    if (redis) await redis.set('brain:' + channel, requested);
    return 'Switching brain to ' + requested + ' mode.';
  }
  return "Brain '" + requested + "' not found. Available: " + Object.keys(brains).join(', ');
}, 'Switch or list brains');

registerBuiltin('!commands', async () => {
  const redis = getRedis();
  if (!redis) return 'No custom commands loaded.';
  const keys = await redis.keys('cmd:*');
  const cmds = await Promise.all(keys.map(async k => {
    const data = await redis.get(k);
    return data ? JSON.parse(data).name : null;
  }));
  const list = cmds.filter(Boolean).join(', ');
  return list ? 'Custom commands: ' + list : 'No custom commands.';
}, 'List custom commands');


registerBuiltin('!clip', async (user, channel, client, message, context = {}) => {
  const detector = context.highlightDetector;
  if (!detector) return '🎬 Clip system is still starting.';
  const result = await detector.requestManualClip({ channel, user, message });
  return result?.message || '🎬 Clip request processed.';
}, 'Create a Twitch clip or cast a viewer clip vote');

registerBuiltin('!mode', async (user, channel, client, message, context = {}) => {
  const streamContext = context.highlightDetector?.getLiveContext(channel) || {};
  return suggestGameModes(streamContext);
}, 'Suggest verified current modes for the live game');

registerBuiltin('!music', (user, channel, client, message, context = {}) => {
  return handleMusicCommand(user, message, context.musicPlayerUrl);
}, 'Show status and control NCS stream music');

registerBuiltin('!play', (user, channel, client, message, context = {}) => {
  return handleMusicCommand(user, message, context.musicPlayerUrl);
}, 'Start NCS stream music (moderators)');

registerBuiltin('!skip', (user) => {
  return handleSkipCommand(user);
}, 'Skip to the next stream music track (moderators)');

const songCommand = String(config.media.musicCommand || '!song').trim().toLowerCase();
if (songCommand.startsWith('!') && !['!music', '!skip'].includes(songCommand)) {
  registerBuiltin(songCommand, () => handleSongCommand(), 'Show the current stream music track');
}

