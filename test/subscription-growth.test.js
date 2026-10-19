import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shouldOfferSubscription, subscriptionLineFor } from '../src/chat/viewerEngagement.js';
import { formatSupportMessage } from '../src/chat/supportMessage.js';
import { createConversationStore } from '../src/memory/conversationStore.js';
import { quietSpeakProbability } from '../src/chat/quietChatterModel.js';

const engagedFollower = {
  firstChatAt: 1_000_000,
  messageCount: 8,
  botInteractions: 4,
  followed: true,
  subscriptionPromptedAt: null,
  proactiveOptOut: false,
  commercialOptOut: false,
};

const eligibleContext = {
  profile: engagedFollower,
  message: 'that was awesome, clean parry',
  directInteraction: true,
  isSubscriber: false,
  recentHumanTurns: 3,
  recentBotReplies: 2,
};

test('subscription prompt is reserved for a repeatedly engaged, positive follower', () => {
  assert.equal(shouldOfferSubscription(eligibleContext), true);
  assert.match(subscriptionLineFor(), /optional/i);
  assert.match(subscriptionLineFor(), /thanks for hanging out/i);
  assert.doesNotMatch(subscriptionLineFor(), /must subscribe|everyone is subscribing|last chance/i);
});

test('subscription prompt is suppressed for subscribers, opt-outs, low engagement, and negative chat', () => {
  assert.equal(shouldOfferSubscription({ ...eligibleContext, isSubscriber: true }), false);
  assert.equal(shouldOfferSubscription({ ...eligibleContext, profile: { ...engagedFollower, followed: false } }), false);
  assert.equal(shouldOfferSubscription({ ...eligibleContext, profile: { ...engagedFollower, subscriptionPromptedAt: 1_100_000 } }), false);
  assert.equal(shouldOfferSubscription({ ...eligibleContext, profile: { ...engagedFollower, proactiveOptOut: true } }), false);
  assert.equal(shouldOfferSubscription({ ...eligibleContext, profile: { ...engagedFollower, commercialOptOut: true } }), false);
  assert.equal(shouldOfferSubscription({ ...eligibleContext, recentHumanTurns: 1 }), false);
  assert.equal(shouldOfferSubscription({ ...eligibleContext, recentBotReplies: 0 }), false);
  assert.equal(shouldOfferSubscription({ ...eligibleContext, directInteraction: false }), false);
  assert.equal(shouldOfferSubscription({ ...eligibleContext, message: 'this is boring' }), false);
});

test('viewer-invoked !support command is registered and gives a clear optional path', () => {
  const source = readFileSync(new URL('../src/commands/builtins.js', import.meta.url), 'utf8');
  const response = formatSupportMessage('#saevond');
  assert.match(source, /registerBuiltin\('!support'/);
  assert.match(response, /following is free/i);
  assert.match(response, /subscription is optional/i);
  assert.match(response, /https:\/\/www\.twitch\.tv\/saevond\/subscribe/);
  assert.match(response, /no pressure/i);
});

test('subscription prompt state remains durable after detailed-profile expiry', async () => {
  const previousRedisUrl = process.env.REDIS_URL;
  const originalNow = Date.now;
  let now = Date.UTC(2026, 0, 1);
  process.env.REDIS_URL = '';

  try {
    Date.now = () => now;
    const { ProfileStore } = await import('../src/memory/profileStore.js');
    ProfileStore.clearMemoryFallbackForTests();
    await ProfileStore.update('#saevond', 'engagedviewer', { subscriptionPromptedAt: now });

    now += 31 * 24 * 60 * 60 * 1000;
    const profile = await ProfileStore.get('#saevond', 'engagedviewer');
    assert.equal(profile.subscriptionPromptedAt, Date.UTC(2026, 0, 1));
  } finally {
    Date.now = originalNow;
    if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previousRedisUrl;
  }
});

test('730-day stress simulation never repeats or mis-targets the optional subscriber CTA', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const start = Date.UTC(2026, 0, 1);
  const profiles = Array.from({ length: 240 }, (_, id) => ({
    ...engagedFollower,
    firstChatAt: start - 180 * DAY,
    messageCount: 8 + id % 6,
    botInteractions: 4 + id % 4,
    followed: id % 2 === 0,
    proactiveOptOut: id % 19 === 0,
    commercialOptOut: id % 23 === 0,
    subscriber: id % 7 === 0,
    subscriptionPromptedAt: null,
  }));
  const promptCounts = new Array(profiles.length).fill(0);
  let prompts = 0;
  let invalidPrompts = 0;

  for (let day = 0; day < 730; day += 1) {
    const at = start + day * DAY;
    for (let slot = 0; slot < 30; slot += 1) {
      const id = (day * 29 + slot) % profiles.length;
      const profile = profiles[id];
      const context = {
        profile,
        message: 'that was awesome, clean parry',
        directInteraction: true,
        isSubscriber: profile.subscriber,
        recentHumanTurns: 3,
        recentBotReplies: 2,
      };
      const offer = shouldOfferSubscription(context);
      if (!offer) continue;

      prompts += 1;
      promptCounts[id] += 1;
      if (!profile.followed || profile.subscriber || profile.proactiveOptOut || profile.commercialOptOut) invalidPrompts += 1;
      profile.subscriptionPromptedAt = at;
      assert.equal(shouldOfferSubscription(context), false, 'a viewer cannot receive a second request');
    }
  }

  assert.ok(prompts > 0);
  assert.equal(invalidPrompts, 0);
  assert.ok(promptCounts.every(count => count <= 1));
});

test('730-day Redis outage simulation preserves human activity and bot fatigue inputs', async () => {
  const DAY = 24 * 60 * 60 * 1000;
  const start = Date.UTC(2026, 0, 1);
  const channel = '#saevond';
  let now = start;
  const store = createConversationStore({
    redisProvider: () => null,
    now: () => now,
    logger: { warn() {} },
  });
  let messages = 0;

  for (let day = 0; day < 730; day += 1) {
    const dayStart = start + day * DAY;
    now = dayStart;
    await store.pushMessage(channel, 'user', `activity-${day}`, 'alice');
    await store.updateLastActivity(channel, dayStart);
    messages += 1;

    now = dayStart + 60_000;
    let lastHumanAt = await store.getLastActivity(channel);
    assert.equal(quietSpeakProbability({ silenceMs: now - lastHumanAt, tickMs: 30_000 }), 0);

    now = dayStart + 6 * 60_000;
    lastHumanAt = await store.getLastActivity(channel);
    assert.ok(quietSpeakProbability({
      silenceMs: now - lastHumanAt,
      tickMs: 30_000,
      recentBotMessages: 0,
    }) >= 0.72);

    await store.pushMessage(channel, 'bot', `nudge-${day}`);
    messages += 1;
    now = dayStart + 6 * 60_000 + 30_000;
    const history = await store.getHistory(channel, 40);
    const recentBots = history.filter(entry =>
      (entry.role === 'bot' || entry.role === 'assistant')
      && Number(entry.ts || 0) >= now - 10 * 60_000
    );
    const lastBotAt = Math.max(...recentBots.map(entry => Number(entry.ts || 0)));
    assert.ok(now - lastBotAt < 120_000, 'the local bot message must still activate the send gap');
    assert.ok(quietSpeakProbability({
      silenceMs: now - await store.getLastActivity(channel),
      tickMs: 30_000,
      recentBotMessages: recentBots.length,
    }) < 0.72, 'stored bot history must activate fatigue instead of the max-quiet floor');

    now = dayStart + 7 * 60_000;
    await store.pushMessage(channel, 'user', `human-returned-${day}`, 'alice');
    await store.updateLastActivity(channel, now);
    messages += 1;
    assert.equal(await store.getLastActivity(channel), now);
    assert.equal(quietSpeakProbability({
      silenceMs: 0,
      tickMs: 30_000,
      recentBotMessages: recentBots.length,
    }), 0, 'new human activity must reset quiet-chat probability');
  }

  assert.equal(messages, 2_190);
});
