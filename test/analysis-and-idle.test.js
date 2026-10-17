import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamMomentTracker } from '../src/chat/streamMomentTracker.js';
import { AnalyticalMomentGate } from '../src/chat/analyticalMomentGate.js';
import { quietSpeakProbability, chooseQuietMode, quietPrompt } from '../src/chat/quietChatterModel.js';
import { EngagementAttribution } from '../src/chat/engagementAttribution.js';
import { AnalystBrain } from '../src/brains/analyst.js';

function seeded(seed = 123456789) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

test('isolated hype from one viewer does not become an automatic analytical moment', () => {
  const tracker = new StreamMomentTracker();
  const gate = new AnalyticalMomentGate({ cooldownMs: 90_000, minScore: 72 });
  const now = 1_000_000;

  const moment = tracker.observe('#saevond', {
    username: 'alice',
    message: 'wow!!',
    now,
  });

  assert.equal(moment.hot, false);
  assert.equal(gate.allow('#saevond', moment, now), false);
});

test('multi-viewer tactical reaction spike becomes an analytical moment', () => {
  const tracker = new StreamMomentTracker();
  const gate = new AnalyticalMomentGate({ cooldownMs: 90_000, minScore: 72 });
  const start = 2_000_000;

  tracker.observe('#saevond', { username: 'alice', message: 'no way that parry was clean!!', now: start });
  tracker.observe('#saevond', { username: 'bob', message: 'huge punish after the dodge', now: start + 1200 });
  const moment = tracker.observe('#saevond', { username: 'charlie', message: 'insane timing on that fight', now: start + 2200 });

  assert.ok(moment.score >= 72, `expected hot score, got ${moment.score}`);
  assert.ok(moment.uniqueUsers >= 3);
  assert.ok(moment.tacticalHits >= 2);
  assert.equal(gate.allow('#saevond', moment, start + 2200), true);
  assert.equal(gate.allow('#saevond', moment, start + 3000), false, 'cooldown must block repeat commentary');
  assert.equal(gate.allow('#saevond', moment, start + 92_500), true);
});

test('analyst brain strongly prioritizes direct tactical questions', async () => {
  const result = await AnalystBrain.score({
    message: 'why was that parry timing so good?',
    context: { moment: { analytical: true, hot: true } },
  });

  const weighted = result.score * result.confidence * result.priority / result.cost;
  assert.ok(weighted > 100);
  assert.equal(typeof AnalystBrain.processResponse, 'function');
  assert.match(AnalystBrain.getConfig().systemPrompt, /do NOT have direct vision/i);
});

test('quiet-chat probability starts at zero, rises with silence, and falls with bot fatigue', () => {
  const before = quietSpeakProbability({ silenceMs: 60_000 });
  const early = quietSpeakProbability({ silenceMs: 150_000, recentBotMessages: 0 });
  const later = quietSpeakProbability({ silenceMs: 300_000, recentBotMessages: 0 });
  const fatigued = quietSpeakProbability({ silenceMs: 300_000, recentBotMessages: 2 });

  assert.equal(before, 0);
  assert.ok(early > 0);
  assert.ok(later > early);
  assert.ok(fatigued < later);
  assert.ok(later <= 0.8);
});

test('quiet mode prefers analysis with evidence, prediction with game context, otherwise community question', () => {
  assert.equal(chooseQuietMode({
    history: [{ role: 'user', content: 'that parry timing was wild' }],
    streamContext: { gameName: 'NARAKA: BLADEPOINT' },
    moment: {},
  }), 'analysis-recap');

  assert.equal(chooseQuietMode({
    history: [],
    streamContext: { gameName: 'ARC Raiders' },
    moment: {},
  }), 'prediction');

  assert.equal(chooseQuietMode({ history: [], streamContext: {}, moment: {} }), 'community-question');

  assert.match(quietPrompt('analysis-recap', { gameName: 'Apex Legends' }), /ONLY on the recent chat\/context/i);
  assert.match(quietPrompt('prediction', { gameName: 'ARC Raiders' }), /few words/i);
});

test('8-hour dead-chat simulation starts earlier than old timer but backs off from bot-only spam', () => {
  const random = seeded(0xC1A0C1A0);
  const TICK = 30_000;
  const BOT_GAP = 120_000;
  const RECENT_WINDOW = 600_000;
  const duration = 8 * 60 * 60 * 1000;
  const botTimes = [];

  for (let now = TICK; now <= duration; now += TICK) {
    const recent = botTimes.filter(at => now - at <= RECENT_WINDOW);
    const lastBot = recent.length ? recent[recent.length - 1] : 0;
    if (lastBot && now - lastBot < BOT_GAP) continue;

    const probability = quietSpeakProbability({
      silenceMs: now,
      tickMs: TICK,
      recentBotMessages: recent.length,
      minQuietMs: 90_000,
      maxQuietMs: 360_000,
    });

    if (random() < probability) botTimes.push(now);
  }

  assert.ok(botTimes.length >= 45, `too quiet: ${botTimes.length} messages`);
  assert.ok(botTimes.length <= 100, `too spammy: ${botTimes.length} messages`);
  assert.ok(botTimes[0] < 10 * 60_000, `first nudge came too late: ${botTimes[0] / 60000} minutes`);

  for (let i = 1; i < botTimes.length; i += 1) {
    assert.ok(botTimes[i] - botTimes[i - 1] >= BOT_GAP);
  }

  // Old fixed behavior could send about every five minutes forever after the ten-minute threshold.
  const oldFixedMaximum = Math.floor((duration - 10 * 60_000) / (5 * 60_000)) + 1;
  assert.ok(botTimes.length < oldFixedMaximum, 'adaptive backoff should reduce bot-only wall-of-text behavior');
});

test('human responses are attributed once to quiet and analytical prompts', () => {
  const tracker = new EngagementAttribution({
    quietResponseWindowMs: 120_000,
    analyticalResponseWindowMs: 90_000,
  });

  tracker.recordQuiet('#saevond', 'prediction', 1_000);
  tracker.recordAnalytical('#saevond', 2_000);

  const first = tracker.recordHuman('#saevond', 30_000);
  assert.equal(first.quietMode, 'prediction');
  assert.equal(first.analytical, true);

  const second = tracker.recordHuman('#saevond', 40_000);
  assert.equal(second.quietMode, null);
  assert.equal(second.analytical, false);
});

test('expired attribution windows do not claim a response', () => {
  const tracker = new EngagementAttribution();
  tracker.recordQuiet('#saevond', 'community-question', 1_000);
  tracker.recordAnalytical('#saevond', 1_000);

  const result = tracker.recordHuman('#saevond', 200_000);
  assert.equal(result.quietMode, null);
  assert.equal(result.analytical, false);
});
