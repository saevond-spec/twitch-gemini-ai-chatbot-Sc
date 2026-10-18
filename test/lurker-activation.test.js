import test from 'node:test';
import assert from 'node:assert/strict';

process.env.REDIS_URL = '';
process.env.TWITCH_USERNAME ||= 'sweatyclanker';
process.env.TWITCH_CLIENT_ID ||= 'test-client';
process.env.TWITCH_CLIENT_SECRET ||= 'test-secret';
process.env.JOIN_CHANNELS ||= 'saevond';
process.env.DEEPSEEK_API_KEY ||= 'test-key';

const {
  activationOpportunity,
  LURKER_PROMPT_ARMS,
  promptForArm,
  scorePromptArm,
} = await import('../src/chat/lurkerActivationMath.js');
const { LurkerActivationEngine } = await import('../src/chat/lurkerActivation.js');
const { LurkerActivationStore } = await import('../src/chat/lurkerActivationStore.js');

function seeded(seed = 0xA11CE) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

test('activation opportunity requires silent chat-connected users', () => {
  assert.equal(activationOpportunity({
    silentUsers: 0,
    silenceMs: 10 * 60_000,
  }), 0);
});

test('more quiet eligible users increase opportunity while bot fatigue reduces it', () => {
  const quiet = activationOpportunity({
    silentUsers: 4,
    silenceMs: 6 * 60_000,
    recentHumanMessages: 0,
    recentBotMessages: 0,
    recentActivationPrompts: 0,
  });
  const noisyBot = activationOpportunity({
    silentUsers: 4,
    silenceMs: 6 * 60_000,
    recentHumanMessages: 0,
    recentBotMessages: 3,
    recentActivationPrompts: 2,
  });
  const oneSilent = activationOpportunity({
    silentUsers: 1,
    silenceMs: 3 * 60_000,
    recentHumanMessages: 0,
    recentBotMessages: 0,
    recentActivationPrompts: 0,
  });

  assert.ok(quiet > oneSilent);
  assert.ok(noisyBot < quiet);
  assert.ok(quiet <= 0.92);
});

test('minimum prompt gap hard-stops repeat nudges', () => {
  const now = 2_000_000;
  assert.equal(activationOpportunity({
    silentUsers: 5,
    silenceMs: 8 * 60_000,
    lastPromptAt: now - 60_000,
    now,
    minPromptGapMs: 240_000,
  }), 0);
});

test('all activation prompts are low-friction and never expose a silent username', () => {
  for (const arm of LURKER_PROMPT_ARMS) {
    const msg = promptForArm(arm, { gameName: 'NARAKA: BLADEPOINT' });
    assert.ok(msg.length < 100, arm);
    assert.doesNotMatch(msg, /@|lurker|viewer list|i see you|why aren.?t you talking/i, arm);
  }
});

test('silent-user tracking has startup warmup, silence threshold, and part cleanup', async () => {
  LurkerActivationStore.clearMemoryForTests();
  let now = 10_000_000;
  const engine = new LurkerActivationEngine({
    warmupMs: 90_000,
    minSilentMs: 180_000,
    now: () => now,
    rng: seeded(),
  });

  assert.equal(engine.onJoin({ channel: '#saevond', username: 'alice', now: now + 30_000 }), false);

  now += 91_000;
  assert.equal(engine.onJoin({ channel: '#saevond', username: 'alice', now }), true);
  assert.equal(engine.eligibleSilentCount('#saevond', now + 100_000), 0);
  assert.equal(engine.eligibleSilentCount('#saevond', now + 181_000), 1);

  engine.onPart({ channel: '#saevond', username: 'alice' });
  assert.equal(engine.eligibleSilentCount('#saevond', now + 182_000), 0);
});

test('organic first chat from a long-silent user is measured but not credited to a prompt', async () => {
  LurkerActivationStore.clearMemoryForTests();
  let now = 20_000_000;
  const engine = new LurkerActivationEngine({
    warmupMs: 0,
    minSilentMs: 180_000,
    now: () => now,
    rng: seeded(),
  });

  engine.onJoin({ channel: '#saevond', username: 'alice', now });
  now += 190_000;
  const result = await engine.onMessage({ channel: '#saevond', username: 'alice', now });

  assert.equal(result.wasSilent, true);
  assert.equal(result.attributed, false);
  assert.equal(result.reason, 'organic_first_chat');
  assert.equal(engine.eligibleSilentCount('#saevond', now), 0);
});

test('first chat inside active prompt window receives one prompt attribution', async () => {
  LurkerActivationStore.clearMemoryForTests();
  let now = 30_000_000;
  const engine = new LurkerActivationEngine({
    warmupMs: 0,
    minSilentMs: 180_000,
    replyWindowMs: 120_000,
    now: () => now,
    rng: seeded(),
  });

  engine.onJoin({ channel: '#saevond', username: 'alice', now });
  now += 181_000;

  await engine.recordPrompt({
    channel: '#saevond',
    selection: {
      eligible: true,
      arm: 'binary',
      silentUsers: 1,
    },
    at: now,
  });

  now += 30_000;
  const result = await engine.onMessage({ channel: '#saevond', username: 'alice', now });
  assert.equal(result.attributed, true);
  assert.equal(result.arm, 'binary');
  assert.equal(result.firstSuccess, true);
  assert.equal(result.latencyMs, 30_000);

  const stats = await LurkerActivationStore.getArmStats('#saevond', 'binary');
  assert.equal(stats.impressions, 1);
  assert.equal(stats.successes, 1);
  assert.equal(stats.activatedUsers, 1);
});

test('multiple silent users can activate from one prompt but success is binary for Thompson learning', async () => {
  LurkerActivationStore.clearMemoryForTests();
  let now = 40_000_000;
  const engine = new LurkerActivationEngine({
    warmupMs: 0,
    minSilentMs: 180_000,
    replyWindowMs: 120_000,
    now: () => now,
    rng: seeded(),
  });

  engine.onJoin({ channel: '#saevond', username: 'alice', now });
  engine.onJoin({ channel: '#saevond', username: 'bob', now });
  now += 181_000;
  await engine.recordPrompt({
    channel: '#saevond',
    selection: { eligible: true, arm: 'emote', silentUsers: 2 },
    at: now,
  });

  now += 10_000;
  const alice = await engine.onMessage({ channel: '#saevond', username: 'alice', now });
  now += 10_000;
  const bob = await engine.onMessage({ channel: '#saevond', username: 'bob', now });

  assert.equal(alice.firstSuccess, true);
  assert.equal(bob.firstSuccess, false);

  const stats = await LurkerActivationStore.getArmStats('#saevond', 'emote');
  assert.equal(stats.impressions, 1);
  assert.equal(stats.successes, 1);
  assert.equal(stats.activatedUsers, 2);
});

test('late first chat is not falsely attributed to an expired prompt', async () => {
  LurkerActivationStore.clearMemoryForTests();
  let now = 50_000_000;
  const engine = new LurkerActivationEngine({
    warmupMs: 0,
    minSilentMs: 180_000,
    replyWindowMs: 120_000,
    now: () => now,
    rng: seeded(),
  });

  engine.onJoin({ channel: '#saevond', username: 'alice', now });
  now += 181_000;
  await engine.recordPrompt({
    channel: '#saevond',
    selection: { eligible: true, arm: 'rating', silentUsers: 1 },
    at: now,
  });

  now += 121_000;
  const result = await engine.onMessage({ channel: '#saevond', username: 'alice', now });
  assert.equal(result.wasSilent, true);
  assert.equal(result.attributed, false);
});

test('90-day Thompson simulation learns the highest first-chat activation arm', () => {
  const rng = seeded(0x90DA7A);
  const syntheticRates = {
    binary: 0.18,
    emote: 0.23,
    rating: 0.14,
    prediction: 0.31,
  };
  const stats = Object.fromEntries(
    LURKER_PROMPT_ARMS.map(arm => [arm, { impressions: 0, successes: 0 }])
  );

  const trials = 90 * 48;
  let predictionSelectionsLast1000 = 0;
  let regret = 0;

  for (let i = 0; i < trials; i += 1) {
    const arms = LURKER_PROMPT_ARMS.map(arm => {
      const row = stats[arm];
      const scored = scorePromptArm({
        arm,
        alpha: 1 + row.successes,
        beta: 9 + row.impressions - row.successes,
        context: {
          gameName: 'ARC Raiders',
          tactical: i % 3 === 0,
          excitement: i % 4 === 0,
        },
        repeatedArm: false,
        recentPromptCount: 0,
        rng,
      });
      return { arm, ...scored };
    }).sort((a, b) => b.score - a.score);

    const chosen = arms[0].arm;
    stats[chosen].impressions += 1;
    if (rng() < syntheticRates[chosen]) stats[chosen].successes += 1;

    regret += syntheticRates.prediction - syntheticRates[chosen];
    if (i >= trials - 1000 && chosen === 'prediction') predictionSelectionsLast1000 += 1;
  }

  const finalRate = predictionSelectionsLast1000 / 1000;
  assert.ok(finalRate > 0.7, 'bandit should strongly favor the synthetic best arm');
  assert.ok(regret / trials < 0.04, 'average synthetic activation regret should remain bounded');

  console.log('LURKER_ACTIVATION_90_DAY_SIMULATION=' + JSON.stringify({
    trials,
    predictionSelectionsLast1000,
    finalBestArmSelectionRate: finalRate,
    averageRegret: regret / trials,
    stats,
  }));
});
