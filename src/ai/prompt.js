
import { getSystemPrompt } from '../../personality.js';
export function buildSystemPrompt(channel, user, context = {}) {
  const base = getSystemPrompt();
  let extra = '';
  if (context.game) extra += `\nCurrent game: ${context.game}`;
  if (context.recentEvents) extra += `\nRecent events: ${context.recentEvents}`;
  return `${base}${extra}`;
}
export function buildUserPrompt(message, username) {
  return `${username}: ${message}`;
}
