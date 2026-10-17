import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  normalizeViewerProfile,
  nextViewerProfile,
  shouldProactivelyWelcome,
  shouldOfferFollow,
} from '../src/chat/viewerEngagement.js';
import { ProactiveWelcomeLimiter } from '../src/chat/proactiveWelcomeLimiter.js';
import { EventSubDeduper } from '../src/twitch/eventsubDeduper.js';
import { IncomingMessageDeduper } from '../src/chat/incomingDeduper.js';
import { StreamMomentTracker } from '../src/chat/streamMomentTracker.js';
import { AnalyticalMomentGate } from '../src/chat/analyticalMomentGate.js';
import { quietSpeakProbability } from '../src/chat/quietChatterModel.js';
import { EngagementAttribution } from '../src/chat/engagementAttribution.js';
import { MessageQueue } from '../src/queue/messageQueue.js';

function rng(seed = 0x5a17c1a5) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function expireDetailedProfile(profile, gapDays) {
  if (gapDays <= 30) return profile;
  return normalizeViewerProfile({
    firstSeen: profile.firstSeen,
    lastSeen: profile.lastSeen,
    followed: profile.followed,
    followedAt: profile.followedAt,
    followPromptedAt: profile.followPromptedAt,
    proactiveOptOut: profile.proactiveOptOut,
    seenBefore: true,
  }, profile.lastSeen);
}

test('five calendar years include leap-day coverage and durable state exceeds the horizon', () => {
  const start = Date.UTC(2026, 9, 17);
  const end = Date.UTC(2031, 9, 17);
  const DAY = 24 * 60 * 60 * 1000;
  const calendarDays = (end - start) / DAY;
  assert.equal(calendarDays, 1826);

  const store = fs.readFileSync(new URL('../src/memory/profileStore.js', import.meta.url), 'utf8');
  assert.match(store, /STATE_TTL_SECONDS = 5 \* 366 \* 24 \* 60 \* 60/);
  assert.ok(5 * 366 > calendarDays);
});

test('1826-day real-world policy simulation preserves viewer, chat, analysis, and delivery invariants', () => {
  const random = rng();
  const DAY = 24 * 60 * 60 * 1000;
  const start = Date.UTC(2026, 9, 17);
  const end = Date.UTC(2031, 9, 17);
  const days = (end - start) / DAY;

  const profiles = new Map();
  const lastActiveDay = new Map();
  const promptCounts = new Map();

  const summary = {
    days,
    sessions: days,
    uniqueChatters: 0,
    messages: 0,
    proactiveWelcomes: 0,
    suppressedBurstWelcomes: 0,
    followPrompts: 0,
    simulatedFollowEvents: 0,
    optOuts: 0,
    returnsAfter30Days: 0,
    returnsAfter2Years: 0,
    erroneousReWelcomes: 0,
    erroneousRepeatPrompts: 0,
    erroneousFollowerPrompts: 0,
    erroneousOptOutPrompts: 0,
    eventSubDuplicatesDropped: 0,
    ircDuplicatesDropped: 0,
    analyticalTruePositives: 0,
    analyticalFalsePositives: 0,
    analyticalCooldownBlocks: 0,
    quietSimulationMessages: 0,
    attributedQuietResponses: 0,
    attributedAnalyticalResponses: 0,
  };

  let viewerCounter = 0;

  for (let day = 0; day < days; day += 1) {
    const dayStart = start + day * DAY;
    const welcomeLimiter = new ProactiveWelcomeLimiter({ maxPerWindow: 3, windowMs: 60_000 });

    const raidDay = day % 30 === 0;
    const majorEventDay = day % 180 === 0;
    const newCount = 5 + Math.floor(random() * 9) + (raidDay ? 50 : 0) + (majorEventDay ? 100 : 0);
    const returningPool = [...profiles.keys()];
    const returningCount = Math.min(returningPool.length, 10 + Math.floor(random() * 16));

    const today = [];
    for (let i = 0; i < newCount; i += 1) {
      today.push({
        id: `viewer-${viewerCounter++}`,
        isNew: true,
        burst: raidDay || majorEventDay,
      });
    }

    for (let i = 0; i < returningCount; i += 1) {
      const id = returningPool[Math.floor(random() * returningPool.length)];
      if (!today.some(entry => entry.id === id)) today.push({ id, isNew: false, burst: false });
    }

    for (let index = 0; index < today.length; index += 1) {
      const entry = today[index];
      let profile = profiles.get(entry.id) || normalizeViewerProfile({}, dayStart);
      const previousDay = lastActiveDay.get(entry.id);
      const gapDays = previousDay === undefined ? 0 : day - previousDay;

      if (gapDays > 30) {
        summary.returnsAfter30Days += 1;
        if (gapDays > 730) summary.returnsAfter2Years += 1;
        profile = expireDetailedProfile(profile, gapDays);
      }

      const numericId = Number(entry.id.split('-')[1]);
      if (numericId % 31 === 0) profile.followed = true;
      if (numericId % 53 === 0) profile.proactiveOptOut = true;

      const messageCount = 1 + Math.floor(random() * 6);
      for (let messageIndex = 0; messageIndex < messageCount; messageIndex += 1) {
        const now = dayStart
          + (entry.burst ? index * 400 : Math.floor(random() * 5 * 60 * 60 * 1000))
          + messageIndex * 20_000;

        const positive = numericId % 6 !== 0;
        const direct = messageIndex > 0 && numericId % 2 === 0;
        const isCommand = messageIndex === 0 && numericId % 19 === 0;
        const message = profile.proactiveOptOut
          ? 'just lurking'
          : isCommand
            ? '!help'
            : positive
              ? (direct ? '@clanker that timing was clean lol' : 'nice fight')
              : 'not feeling that play';

        profile = nextViewerProfile(profile, message, now);
        summary.messages += 1;

        const candidateWelcome = shouldProactivelyWelcome({
          profile,
          message,
          isCommand,
        });

        if (candidateWelcome) {
          if (welcomeLimiter.allow('#saevond', now)) {
            summary.proactiveWelcomes += 1;
            profile.botInteractions += 1;
          } else if (entry.burst) {
            summary.suppressedBurstWelcomes += 1;
          }
        }

        if (!entry.isNew && gapDays > 30 && candidateWelcome) summary.erroneousReWelcomes += 1;

        const offer = shouldOfferFollow({
          profile,
          message,
          now,
          directInteraction: direct,
        });

        if (offer) {
          summary.followPrompts += 1;
          promptCounts.set(entry.id, (promptCounts.get(entry.id) || 0) + 1);
          if (profile.followed) summary.erroneousFollowerPrompts += 1;
          if (profile.proactiveOptOut) summary.erroneousOptOutPrompts += 1;
          if ((promptCounts.get(entry.id) || 0) > 1) summary.erroneousRepeatPrompts += 1;

          profile.followPromptedAt = now;
          profile.botInteractions += 1;

          if (numericId % 4 === 0) {
            profile.followed = true;
            profile.followedAt = now + 5000;
            summary.simulatedFollowEvents += 1;
          }
        } else if (direct) {
          profile.botInteractions += 1;
        }
      }

      if (profile.proactiveOptOut && entry.isNew) summary.optOuts += 1;
      profiles.set(entry.id, { ...profile, seenBefore: true });
      lastActiveDay.set(entry.id, day);
    }

    // Twitch EventSub is at-least-once; exercise duplicate IDs every week.
    if (day % 7 === 0) {
      const deduper = new EventSubDeduper();
      for (let i = 0; i < 6; i += 1) {
        const metadata = {
          message_id: `event-${day}-${i}`,
          message_timestamp: new Date(dayStart).toISOString(),
        };
        assert.equal(deduper.shouldProcess(metadata, dayStart), true);
        assert.equal(deduper.shouldProcess(metadata, dayStart + 1500), false);
        summary.eventSubDuplicatesDropped += 1;
      }
    }

    if (day % 13 === 0) {
      const deduper = new IncomingMessageDeduper(120_000);
      const tags = { id: `irc-${day}`, username: 'simviewer' };
      assert.equal(deduper.isDuplicate('#saevond', tags), false);
      assert.equal(deduper.isDuplicate('#saevond', tags), true);
      summary.ircDuplicatesDropped += 1;
    }

    // Exercise analytical false-positive rejection and real multi-viewer spikes twice a month.
    if (day % 15 === 0) {
      const tracker = new StreamMomentTracker();
      const gate = new AnalyticalMomentGate({ cooldownMs: 90_000, minScore: 72 });
      const base = dayStart + 6 * 60 * 60 * 1000;

      const weak = tracker.observe('#saevond', { username: 'solo', message: 'wow!!', now: base });
      if (gate.allow('#saevond', weak, base)) summary.analyticalFalsePositives += 1;

      tracker.observe('#saevond', { username: 'alice', message: 'no way that parry was clean!!', now: base + 20_000 });
      tracker.observe('#saevond', { username: 'bob', message: 'huge punish after the dodge', now: base + 21_000 });
      const hot = tracker.observe('#saevond', { username: 'charlie', message: 'insane timing on that fight', now: base + 22_000 });
      if (gate.allow('#saevond', hot, base + 22_000)) summary.analyticalTruePositives += 1;
      if (!gate.allow('#saevond', hot, base + 23_000)) summary.analyticalCooldownBlocks += 1;
    }

    // Weekly quiet-stream Monte Carlo: four hours without human chat.
    if (day % 7 === 0) {
      const TICK = 30_000;
      const BOT_GAP = 120_000;
      const WINDOW = 600_000;
      const duration = 4 * 60 * 60 * 1000;
      const botTimes = [];
      for (let now = TICK; now <= duration; now += TICK) {
        const recent = botTimes.filter(at => now - at <= WINDOW);
        const lastBot = recent.length ? recent[recent.length - 1] : 0;
        if (lastBot && now - lastBot < BOT_GAP) continue;

        const p = quietSpeakProbability({
          silenceMs: now,
          tickMs: TICK,
          recentBotMessages: recent.length,
          minQuietMs: 90_000,
          maxQuietMs: 360_000,
        });
        if (random() < p) botTimes.push(now);
      }
      assert.ok(botTimes.length >= 15 && botTimes.length <= 55, `weekly quiet simulation out of bounds: ${botTimes.length}`);
      summary.quietSimulationMessages += botTimes.length;
    }

    // Attribution windows should count each human response once.
    if (day % 11 === 0) {
      const attribution = new EngagementAttribution();
      attribution.recordQuiet('#saevond', 'prediction', dayStart + 1000);
      attribution.recordAnalytical('#saevond', dayStart + 2000);
      const response = attribution.recordHuman('#saevond', dayStart + 30_000);
      if (response.quietMode) summary.attributedQuietResponses += 1;
      if (response.analytical) summary.attributedAnalyticalResponses += 1;
      const duplicate = attribution.recordHuman('#saevond', dayStart + 40_000);
      assert.equal(duplicate.quietMode, null);
      assert.equal(duplicate.analytical, false);
    }
  }

  summary.uniqueChatters = profiles.size;

  assert.equal(summary.days, 1826);
  assert.equal(summary.erroneousReWelcomes, 0);
  assert.equal(summary.erroneousRepeatPrompts, 0);
  assert.equal(summary.erroneousFollowerPrompts, 0);
  assert.equal(summary.erroneousOptOutPrompts, 0);
  assert.equal(summary.analyticalFalsePositives, 0);
  assert.ok(summary.analyticalTruePositives > 100);
  assert.equal(summary.analyticalTruePositives, summary.analyticalCooldownBlocks);
  assert.ok(summary.suppressedBurstWelcomes > 1000);
  assert.ok(summary.eventSubDuplicatesDropped > 1000);
  assert.ok(summary.ircDuplicatesDropped > 100);
  assert.ok(summary.messages > 150_000);
  assert.ok(summary.uniqueChatters > 20_000);
  assert.ok(summary.quietSimulationMessages > 5_000);
  assert.ok(summary.attributedQuietResponses > 100);
  assert.equal(summary.attributedQuietResponses, summary.attributedAnalyticalResponses);

  console.log('FIVE_YEAR_SIMULATION_SUMMARY=' + JSON.stringify(summary));
});

test('message queue enforces Twitch global 20-per-30s limit across many channels', async () => {
  const originalNow = Date.now;
  const originalLimit = process.env.TWITCH_GLOBAL_MESSAGES_PER_30S;
  process.env.TWITCH_GLOBAL_MESSAGES_PER_30S = '20';

  let now = 50_000_000;
  Date.now = () => now;
  const sent = [];
  const client = {
    say: async (channel, message) => {
      sent.push({ channel, message, at: Date.now() });
    },
  };

  const queue = new MessageQueue(client);
  queue.stop();

  try {
    for (let i = 0; i < 25; i += 1) {
      queue.enqueue(`#channel-${i}`, `message-${i}`);
    }

    await queue.process();
    assert.equal(sent.length, 20, 'first processing pass must stop at account-wide 20-message bucket');

    await queue.process();
    assert.equal(sent.length, 20, 'bucket must not refill before 30 seconds');

    now += 29_999;
    await queue.process();
    assert.equal(sent.length, 20);

    now += 1;
    await queue.process();
    assert.equal(sent.length, 25, 'remaining messages may send after the 30-second refill');
  } finally {
    queue.stop();
    Date.now = originalNow;
    if (originalLimit === undefined) delete process.env.TWITCH_GLOBAL_MESSAGES_PER_30S;
    else process.env.TWITCH_GLOBAL_MESSAGES_PER_30S = originalLimit;
  }
});
