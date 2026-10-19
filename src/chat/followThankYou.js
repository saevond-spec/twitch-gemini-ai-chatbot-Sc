const TWITCH_LOGIN = /^[a-z0-9_]{1,25}$/;

export const FOLLOW_THANK_YOU_VARIANTS = [
  "Thanks for the follow, @{{viewer}}! Glad you're here, cuh 💛",
  "Ayy @{{viewer}}, appreciate the follow—welcome in, cuh 😎",
  "Yo @{{viewer}}, thanks for following! Glad you're hanging out, cuh 🤖",
  "@{{viewer}}, thanks for the follow—hope you enjoy the stream, cuh 🎮",
  "Big thanks for the follow, @{{viewer}}! Welcome to the chaos, cuh 😂",
  "Appreciate you following, @{{viewer}}—good to have you here, cuh 😄",
  "Ayy, a new follow from @{{viewer}}—thanks for joining us, cuh 💛",
  "@{{viewer}} just followed! Thanks for the support, cuh 😎",
  "Thanks for joining the channel, @{{viewer}}! Glad you're here, cuh 🤖",
  "Yo, appreciate the follow, @{{viewer}}—pull up and enjoy, cuh 🎮",
  "Welcome to the crew, @{{viewer}}! Thanks for the follow, cuh 😄",
  "@{{viewer}}, much love for the follow—settle in, cuh 💛",
  "Thanks for the follow, @{{viewer}}—chat just got livelier, cuh 😂",
  "Ayy @{{viewer}}, welcome aboard! Appreciate you following, cuh 😎",
  "Glad you hit follow, @{{viewer}}—thanks for being here, cuh 🤖",
  "@{{viewer}}, thanks for the follow! Hope we get a good play for you, cuh 🎮",
  "The stream says thanks for the follow, @{{viewer}}—glad you made it, cuh 😄",
  "Yo @{{viewer}}, thanks for tapping follow and joining the hangout, cuh 😎",
  "Appreciate the follow, @{{viewer}}—make yourself comfy, cuh 🤖",
  "Ayy @{{viewer}}, thanks for riding with the channel, cuh 💛",
  "Thanks for the follow, @{{viewer}}! Enjoy the match, cuh 🎮",
  "@{{viewer}}, you followed—thank you! Kick back and enjoy, cuh 😎",
  "Sending love to @{{viewer}} for the follow—thanks for being here, cuh 💛",
  "Thanks for finding the channel and following, @{{viewer}}—glad you're here, cuh 😄",
  "Yo @{{viewer}}, thanks for the follow—you're officially in the mix, cuh 😂",
  "Ayy, thanks for the follow, @{{viewer}}—hope you like the vibes, cuh 😎",
  "The gang got bigger, @{{viewer}}! Thanks for following, cuh 🎮",
  "@{{viewer}} followed the channel—thanks a bunch, cuh 💛",
  "Thanks for clicking follow, @{{viewer}}! Glad you're hanging out, cuh 🤖",
  "Yo @{{viewer}}, thanks for backing the stream with a follow, cuh 😄",
  "@{{viewer}}, welcome to the channel! Appreciate the follow, cuh 🎮",
  "Big love, @{{viewer}}—thanks for the follow and the good energy, cuh 😎",
  "Thanks for rolling through and following, @{{viewer}}—enjoy the chaos, cuh 😂",
  "Ayy @{{viewer}}, appreciate you choosing to follow—welcome in, cuh 💛",
  "@{{viewer}} just joined the squad! Thanks for hitting follow, cuh 🎮",
  "Thanks for the follow, @{{viewer}}—glad you caught us live, cuh 😄",
  "Yo @{{viewer}}, happy you followed! Hope the stream keeps you entertained, cuh 🤖",
  "The follow notification came through, @{{viewer}}—thank you, cuh 😎",
  "@{{viewer}}, thanks for making this channel part of your feed, cuh 💛",
  "Ayy, we appreciate the follow, @{{viewer}}! Stay for the chaos, cuh 😂",
  "Welcome in, @{{viewer}}—and thanks for giving the channel a follow, cuh 🎮",
  "Thanks for following along, @{{viewer}}; hope you enjoy the next round, cuh 😎",
  "@{{viewer}}, huge thanks for the follow—glad you pulled up, cuh 🤖",
  "Yo, thanks for joining us with a follow, @{{viewer}}—good to have you, cuh 😄",
  "Ayy @{{viewer}}, the follow means a lot—thanks for being here, cuh 💛",
  "@{{viewer}}, thanks for helping the channel grow with a follow, cuh 😎",
  "Glad you found the stream, @{{viewer}}! Thanks for following, cuh 🎮",
  "Thanks for the follow, @{{viewer}}—come hang whenever you like, cuh 🤖",
  "@{{viewer}}, welcome aboard and thanks for the support, cuh 😄",
  "Yo @{{viewer}}, thanks for the follow! Chat's better with you around, cuh 😎",
  "Ayy @{{viewer}}, thanks for joining the crew with a follow, cuh 💛",
  "Thanks for following, @{{viewer}}; get comfy and enjoy the gameplay, cuh 🎮",
  "The stream got a little boost from @{{viewer}}—thanks for the follow, cuh 😎",
  "@{{viewer}}, appreciate the follow! Hope you catch a clutch play, cuh 🎮",
  "Thanks for joining this corner of Twitch, @{{viewer}}—glad you followed, cuh 🤖",
  "Ayy, thanks for the follow, @{{viewer}}—let's see what happens next, cuh 😄",
  "@{{viewer}}, thanks for the follow! We're glad you're along for the ride, cuh 😎",
  "Yo @{{viewer}}, welcome in—thanks for following the stream, cuh 🎮",
  "Thanks for supporting the channel with a follow, @{{viewer}}; much love, cuh 💛",
  "@{{viewer}} followed! Appreciate you stopping by and joining in, cuh 🤖",
  "Ayy @{{viewer}}, thanks for the follow—hope today's stream's a good one, cuh 😄",
  "Good to have you here, @{{viewer}}; thanks for following, cuh 😎",
  "Welcome to the hangout, @{{viewer}}! Thanks for the follow, cuh 🤖",
  "@{{viewer}}, thanks for joining the audience—enjoy the show, cuh 🎮",
  "Yo, a follow from @{{viewer}}! Appreciate the support, cuh 💛",
  "Thanks for following the channel, @{{viewer}}—grab a seat and enjoy, cuh 😄",
  "Ayy @{{viewer}}, glad you decided to follow—welcome to the stream, cuh 😎",
  "@{{viewer}}, thanks for the follow! No pressure, just good vibes, cuh 🤖",
  "Appreciate you being here and following, @{{viewer}}—let's game, cuh 🎮",
  "Yo @{{viewer}}, your follow is a W—thanks for joining us, cuh 😎",
  "Thanks for the follow, @{{viewer}}! Hope we can make this a fun stream, cuh 😄",
  "@{{viewer}}, glad to have you in chat—thanks for the follow, cuh 🤖",
  "Ayy, thanks for joining the channel, @{{viewer}}! Enjoy the action, cuh 🎮",
  "@{{viewer}}, appreciate the follow and the support—welcome in, cuh 💛",
  "Yo, thanks for the follow, @{{viewer}}—kick back and catch the action, cuh 😎",
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
