const TWITCH_LOGIN = /^[a-z0-9_]{1,25}$/;

export function buildFollowThankYou(event = {}) {
  const channelLogin = String(event?.broadcaster_user_login || '').trim().toLowerCase();
  const viewerLogin = String(event?.user_login || '').trim().toLowerCase();

  if (!TWITCH_LOGIN.test(channelLogin) || !TWITCH_LOGIN.test(viewerLogin)) return null;

  return {
    channel: `#${channelLogin}`,
    viewer: viewerLogin,
    message: `Thanks for the follow, @${viewerLogin}! Glad you're here 💛`,
  };
}
