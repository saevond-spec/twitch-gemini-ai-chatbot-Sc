export function formatSupportMessage(channel) {
  const channelName = String(channel || '').replace(/^#/, '').trim();
  const subscribeUrl = channelName
    ? ` https://www.twitch.tv/${encodeURIComponent(channelName)}/subscribe`
    : '';
  return `Following is free; a subscription is optional support and can unlock channel perks. No pressure—thanks for hanging out.${subscribeUrl}`;
}
