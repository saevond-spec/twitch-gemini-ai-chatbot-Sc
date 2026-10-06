import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeViewerProfile,
  nextViewerProfile,
  shouldProactivelyWelcome,
  shouldOfferFollow,
} from '../src/chat/viewerEngagement.js';
import { ProactiveWelcomeLimiter } from '../src/chat/proactiveWelcomeLimiter.js';
import { EventSubDeduper } from '../src/twitch/eventsubDeduper.js';
import { IncomingMessageDeduper } from '../src/chat/incomingDeduper.js';

function rng(seed = 0x5eed1234) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function resetTransientAfterProfileExpiry(profile, gapDays) {
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

test('730-day real-world conversation policy simulation preserves safety and conversion invariants', () => {
  const random = rng();
  const DAY = 24 * 60 * 60 * 1000;
  const start = Date.UTC(2026, 0, 1);
  const profiles = new Map();
  const lastActiveDay = new Map();
  const promptCounts = new Map();

  const summary = {
    days: 730,
    sessions: 730,
    uniqueChatters: 0,
    messages: 0,
    proactiveWelcomes: 0,
    suppressedRaidWelcomes: 0,
    followPrompts: 0,
    simulatedFollowsAfterPrompt: 0,
    optOuts: 0,
    returningAfter30Days: 0,
    erroneousReWelcomes: 0,
    erroneousRepeatPrompts: 0,
    erroneousFollowerPrompts: 0,
    erroneousOptOutPrompts: 0,
    eventSubDuplicatesDropped: 0,
    ircDuplicatesDropped: 0,
  };

  let viewerCounter = 0;

  for (let day = 0; day < 730; day += 1) {
    const dayStart = start + day * DAY;
    const welcomeLimiter = new ProactiveWelcomeLimiter({ maxPerWindow: 3, windowMs: 60_000 });

    // Regular days bring a modest number of new chatters; every 30th day includes a raid-like burst.
    const raidDay = day % 30 === 0;
    const newCount = 6 + Math.floor(random() * 8) + (raidDay ? 60 : 0);
    const returningPool = [...profiles.keys()];
    const returningCount = Math.min(returningPool.length, 8 + Math.floor(random() * 12));

    const today = [];
    for (let i = 0; i < newCount; i += 1) {
      const id = `viewer-${viewerCounter++}`;
      today.push({ id, isNew: true, burst: raidDay && i >= newCount - 60 });
    }
    for (let i = 0; i < returningCount; i += 1) {
      const id = returningPool[Math.floor(random() * returningPool.length)];
      if (!today.some(v => v.id === id)) today.push({ id, isNew: false, burst: false });
    }

    for (let index = 0; index < today.length; index += 1) {
      const entry = today[index];
      let profile = profiles.get(entry.id) || normalizeViewerProfile({}, dayStart);
      const previousDay = lastActiveDay.get(entry.id);
      const gapDays = previousDay === undefined ? 0 : day - previousDay;

      if (gapDays > 30) {
        summary.returningAfter30Days += 1;
        profile = resetTransientAfterProfileExpiry(profile, gapDays);
      }

      // Stable scenario assignment per viewer. These are simulation assumptions, not market-rate claims.
      const numericId = Number(entry.id.split('-')[1]);
      if (numericId % 29 === 0) profile.followed = true;
      if (numericId % 47 === 0) profile.proactiveOptOut = true;

      const messageCount = 1 + Math.floor(random() * 5);
      let welcomedThisSession = false;

      for (let messageIndex = 0; messageIndex < messageCount; messageIndex += 1) {
        const now = dayStart
          + (entry.burst ? index * 500 : Math.floor(random() * 4 * 60 * 60 * 1000))
          + messageIndex * 25_000;

        const positive = numericId % 5 !== 0;
        const direct = messageIndex > 0 && numericId % 2 === 0;
        const isCommand = messageIndex === 0 && numericId % 17 === 0;
        const text = profile.proactiveOptOut
          ? 'just watching'
          : isCommand
            ? '!help'
            : positive
              ? (direct ? '@clanker lol that was awesome' : 'that play was nice')
              : 'not really feeling this one';

        profile = nextViewerProfile(profile, text, now);
        summary.messages += 1;

        const candidateWelcome = shouldProactivelyWelcome({
          profile,
          message: text,
          isCommand,
        });

        if (candidateWelcome) {
          const allowed = welcomeLimiter.allow('#saevond', now);
          if (allowed) {
            summary.proactiveWelcomes += 1;
            welcomedThisSession = true;
            profile.botInteractions += 1;
          } else if (entry.burst) {
            summary.suppressedRaidWelcomes += 1;
          }
        }

        if (!entry.isNew && gapDays > 30 && candidateWelcome) {
          summary.erroneousReWelcomes += 1;
        }

        const offer = shouldOfferFollow({
          profile,
          message: text,
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

          // Deterministic post-prompt follow event for a subset, used only to exercise follower-state suppression.
          if (numericId % 4 === 0) {
            profile.followed = true;
            profile.followedAt = now + 5000;
            summary.simulatedFollowsAfterPrompt += 1;
          }
        } else if (direct || welcomedThisSession) {
          profile.botInteractions += direct ? 1 : 0;
        }
      }

      if (profile.proactiveOptOut) summary.optOuts += entry.isNew ? 1 : 0;
      profiles.set(entry.id, { ...profile, seenBefore: true });
      lastActiveDay.set(entry.id, day);
    }

    // Twitch EventSub is at-least-once: every week exercise duplicate delivery.
    if (day % 7 === 0) {
      const deduper = new EventSubDeduper();
      for (let i = 0; i < 5; i += 1) {
        const metadata = {
          message_id: `day-${day}-event-${i}`,
          message_timestamp: new Date(dayStart).toISOString(),
        };
        assert.equal(deduper.shouldProcess(metadata, dayStart), true);
        assert.equal(deduper.shouldProcess(metadata, dayStart + 1000), false);
        summary.eventSubDuplicatesDropped += 1;
      }
    }

    // Exercise duplicate IRC delivery independently.
    if (day % 11 === 0) {
      const deduper = new IncomingMessageDeduper(120_000);
      const tags = { id: `irc-${day}`, username: 'simviewer' };
      assert.equal(deduper.isDuplicate('#saevond', tags), false);
      assert.equal(deduper.isDuplicate('#saevond', tags), true);
      summary.ircDuplicatesDropped += 1;
    }
  }

  summary.uniqueChatters = profiles.size;

  assert.equal(summary.erroneousReWelcomes, 0, 'known returning viewers must not be welcomed as new after profile expiry');
  assert.equal(summary.erroneousRepeatPrompts, 0, 'a viewer must never receive more than one follow CTA in the two-year horizon');
  assert.equal(summary.erroneousFollowerPrompts, 0, 'known followers must never be asked to follow');
  assert.equal(summary.erroneousOptOutPrompts, 0, 'opted-out viewers must never receive proactive follow CTAs');
  assert.ok(summary.suppressedRaidWelcomes > 0, 'raid bursts should trigger proactive welcome load shedding');
  assert.ok(summary.eventSubDuplicatesDropped > 0);
  assert.ok(summary.ircDuplicatesDropped > 0);
  assert.ok(summary.messages > 50_000, 'simulation should exercise a substantial interaction volume');

  console.log('TWO_YEAR_SIMULATION_SUMMARY=' + JSON.stringify(summary));
});

test('EventSub deduper drops stale replayed notifications', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  const deduper = new EventSubDeduper({ maxAgeMs: 10 * 60 * 1000 });
  assert.equal(deduper.shouldProcess({
    message_id: 'fresh',
    message_timestamp: new Date(now - 60_000).toISOString(),
  }, now), true);
  assert.equal(deduper.shouldProcess({
    message_id: 'stale',
    message_timestamp: new Date(now - 11 * 60_000).toISOString(),
  }, now), false);
});

test('raid burst allows only three proactive welcomes in a minute', () => {
  const limiter = new ProactiveWelcomeLimiter({ maxPerWindow: 3, windowMs: 60_000 });
  const start = 1_000_000;
  const decisions = [];
  for (let i = 0; i < 50; i += 1) decisions.push(limiter.allow('#saevond', start + i * 500));
  assert.equal(decisions.filter(Boolean).length, 3);
  assert.equal(decisions.filter(v => !v).length, 47);
  assert.equal(limiter.allow('#saevond', start + 61_000), true);
});
