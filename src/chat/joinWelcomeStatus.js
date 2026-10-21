export function joinWelcomeAuthMessage(status = {}, botLogin = 'the bot') {
  const bot = `@${String(botLogin || 'the bot').replace(/^@/, '')}`;
  if (status.ready) {
    return `Twitch authorization succeeded for ${bot}. Named join welcomes are ready; you may close this window.`;
  }

  const failures = Array.isArray(status.failures) ? status.failures : [];
  const roleFailure = failures.find(failure => failure.reason === 'bot_not_channel_moderator');
  if (roleFailure) {
    const channel = roleFailure.channel || 'the channel';
    return `Twitch authorization succeeded for ${bot}, but join welcomes are waiting. Make ${bot} a moderator in ${channel}; the watcher will retry automatically.`;
  }

  const unauthorized = status.disabledReason === 'twitch_unauthorized'
    || failures.some(failure => failure.reason === 'twitch_unauthorized');
  if (unauthorized) {
    return `Twitch authorization succeeded for ${bot}, but Twitch rejected the chatter lookup (401). Reauthorize the configured bot account with moderator:read:chatters and verify the Twitch app client ID.`;
  }

  if (failures.length) {
    return `Twitch authorization succeeded for ${bot}, but the chatter list is not available yet. The watcher will retry automatically; check again after the next poll.`;
  }

  return `Twitch authorization succeeded for ${bot}, but named join welcomes are not confirmed ready yet. The watcher will retry automatically.`;
}
