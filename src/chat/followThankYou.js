const TWITCH_LOGIN = /^[a-z0-9_]{1,25}$/;

export const FOLLOW_THANK_YOU_VARIANTS = [
  "Thanks for the follow, @{{viewer}}!",
  "Ayy, appreciate the follow, @{{viewer}}, cuh.",
  "Yo @{{viewer}}, thanks for following!",
  "Welcome in, @{{viewer}}—thanks for the follow.",
  "@{{viewer}} followed! Appreciate you.",
  "Good to have you here, @{{viewer}}. Thanks for the follow!",
  "Cuh, @{{viewer}}! Appreciate the follow—welcome in.",
  "Thanks for tapping follow, @{{viewer}}.",
  "Much love for the follow, @{{viewer}} 💛",
  "Glad you found the stream, @{{viewer}}—thanks for following.",
  "Appreciate you following, @{{viewer}}!",
  "@{{viewer}}, thanks for pulling up and following.",
  "Thanks for checking out the stream, @{{viewer}}!",
  "Ayy, welcome to chat, @{{viewer}}—thanks for following.",
  "@{{viewer}}, good looking out with the follow, cuh.",
  "Thanks for the follow, @{{viewer}}. Enjoy the game!",
  "Yo, appreciate you, @{{viewer}}—welcome in.",
  "@{{viewer}} is here! Thanks for the follow.",
  "Glad you followed, @{{viewer}}—thanks for stopping by!",
  "Thanks for being here, @{{viewer}}—glad you followed.",
  "Ayy, thanks for the follow, @{{viewer}}, cuh.",
  "Good timing, @{{viewer}}—thanks for following!",
  "@{{viewer}}, welcome to the stream. Appreciate the follow.",
  "Thanks for coming through, @{{viewer}}—appreciate the follow, cuh.",
  "Hey @{{viewer}}, glad you made it. Thanks for following.",
  "@{{viewer}}, thanks for joining the chat!",
  "Ayy @{{viewer}}, good to have you in here—thanks for following.",
  "Thanks for giving us a follow, @{{viewer}}.",
  "@{{viewer}} pulled up—appreciate you following!",
  "Yo, welcome in @{{viewer}}—thanks for the follow, cuh.",
  "@{{viewer}}, really appreciate the follow.",
  "Thanks for stopping by, @{{viewer}}!",
  "Welcome to the chaos, @{{viewer}}—thanks for following, cuh.",
  "@{{viewer}}, thanks for finding us.",
  "Appreciate the follow, @{{viewer}}. Settle in.",
  "Ayy, thanks for following along, @{{viewer}}.",
  "@{{viewer}}, glad you're here. Appreciate the follow.",
  "Thanks for joining us live, @{{viewer}}—welcome!",
  "Yo @{{viewer}}, appreciate you dropping in.",
  "@{{viewer}}, the follow's appreciated—welcome in.",
  "@{{viewer}}, thanks for hitting follow—hope you enjoy the game.",
  "Ayy, good looking out, @{{viewer}}—thanks for the follow, cuh.",
  "Welcome aboard, @{{viewer}}! Appreciate you following.",
  "@{{viewer}}—thanks for the follow. You're in, cuh.",
  "Thanks for rolling through, @{{viewer}}. Good to have you.",
  "Yo, thanks for the follow, @{{viewer}}—glad you're here.",
  "@{{viewer}}, appreciate the follow. Catch you around chat.",
  "A new follow! Thanks for coming through, @{{viewer}}. Cuh!",
  "Hey, @{{viewer}}—thanks for joining the stream.",
  "@{{viewer}}, thanks for following the channel.",
  "Appreciate you stopping by and following, @{{viewer}}.",
  "@{{viewer}}, thanks for the follow! 💛",
  "Glad you found us, @{{viewer}}. Appreciate you following.",
  "Thanks for pulling up, @{{viewer}}—welcome in.",
  "Ayy @{{viewer}}, thanks for being here, cuh.",
  "@{{viewer}}, welcome to the stream. Thanks for following.",
  "Appreciate the follow, @{{viewer}}—much love, cuh.",
  "Yo @{{viewer}}, thanks for coming through!",
  "Thanks for the follow, @{{viewer}}. Let's see how this match goes.",
  "@{{viewer}}, happy to have you here—thanks for following, cuh.",
  "Good to see you in chat, @{{viewer}}. Appreciate the follow.",
  "Thanks for checking us out, @{{viewer}}!",
  "Ayy, thanks for the follow, @{{viewer}}—welcome to the match.",
  "@{{viewer}} joined the stream—thanks for following.",
  "Much appreciated, @{{viewer}}. Welcome in.",
  "Thanks for dropping by, @{{viewer}}—glad you followed.",
  "@{{viewer}}, thanks for making it to the stream.",
  "Yo @{{viewer}}, welcome in—good looking out with the follow, cuh.",
  "Appreciate you joining, @{{viewer}}—glad you followed.",
  "Thanks for the follow, @{{viewer}}. Hang out if you want.",
  "@{{viewer}}, glad you pulled up. Appreciate the follow, cuh.",
  "Hey @{{viewer}}, thanks for the follow. Enjoy the stream.",
  "Thanks for following, @{{viewer}}—we're getting into it.",
  "@{{viewer}}, welcome in! Thanks for giving the stream a follow.",
  "Thanks for the follow, @{{viewer}}—let's get into this game, cuh.",
];

export function buildFollowThankYou(event = {}, variantIndex = 0) {
  const channelLogin = String(event?.broadcaster_user_login || '').trim().toLowerCase();
  const viewerLogin = String(event?.user_login || '').trim().toLowerCase();

  if (!TWITCH_LOGIN.test(channelLogin) || !TWITCH_LOGIN.test(viewerLogin)) return null;

  const index = Math.abs(Math.trunc(Number(variantIndex) || 0)) % FOLLOW_THANK_YOU_VARIANTS.length;
  return {
    channel: `#${channelLogin}`,
    viewer: viewerLogin,
    message: FOLLOW_THANK_YOU_VARIANTS[index].replaceAll('{{viewer}}', viewerLogin),
  };
}

export class FollowThankYouRotator {
  constructor() {
    this.nextIndexByChannel = new Map();
  }

  build(event = {}) {
    const nextIndex = this.nextIndexByChannel.get(
      `#${String(event?.broadcaster_user_login || '').trim().toLowerCase()}`
    ) || 0;
    const follow = buildFollowThankYou(event, nextIndex);
    if (!follow) return null;

    this.nextIndexByChannel.set(
      follow.channel,
      (nextIndex + 1) % FOLLOW_THANK_YOU_VARIANTS.length
    );
    return follow;
  }
}
