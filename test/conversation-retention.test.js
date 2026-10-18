import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TWITCH_USERNAME ||= 'sweatyclanker';
process.env.TWITCH_CLIENT_ID ||= 'test-client';
process.env.TWITCH_CLIENT_SECRET ||= 'test-secret';
process.env.JOIN_CHANNELS ||= 'saevond';
process.env.DEEPSEEK_API_KEY ||= 'test-key';
process.env.REDIS_URL = '';

const {
  retentionOpportunityScore,
  canAskQuestion,
  scoreRetentionArm,
} = await import('../src/chat/retentionMath.js');
const {
  ConversationRetentionEngine,
  RETENTION_STRATEGIES,
} = await import('../src/chat/conversationRetention.js');
const { RetentionStore } = await import('../src/chat/retentionStore.js');

function seeded(seed = 0xC0FFEE) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function engagedProfile(now = 1_000_000) {
  return {
    firstChatAt: now - 8 * 60_000,
    messageCount: 6,
    botInteractions: 3,
    proactiveOptOut: false,
    lastBotReplyAt: now - 30_000,
    lastRetentionPromptAt: null,
    lastRetentionStrategy: null,
    retentionPromptCount: 0,
  };
}

test('retention opportunity is selective: new viewer low, engaged direct viewer high', () => {
  const newViewer = retentionOpportunityScore({
    messageCount: 1,
    botInteractions: 0,
    sessionAgeMs: 10_000,
    recentHumanTurns: 0,
    recentBotQuestions: 0,
    directInteraction: true,
    message: 'hey',
  });
  const engaged = retentionOpportunityScore({
    messageCount: 6,
    botInteractions: 3,
    sessionAgeMs: 8 * 60_000,
    recentHumanTurns: 3,
    recentBotQuestions: 0,
    responseLatencyMs: 20_000,
    directInteraction: true,
    message: 'lol that timing was clean',
  });

  assert.ok(newViewer < 0.56);
  assert.ok(engaged > 0.8);
});

test('negative context and proactive opt-out zero the retention opportunity', () => {
  assert.equal(retentionOpportunityScore({
    messageCount: 10,
    botInteractions: 5,
    directInteraction: true,
    message: 'this bot is annoying',
  }), 0);

  assert.equal(retentionOpportunityScore({
    messageCount: 10,
    botInteractions: 5,
    directInteraction: true,
    message: 'nice',
    proactiveOptOut: true,
  }), 0);
});

test('question fatigue lowers opportunity and hard-disables another question', () => {
  const base = {
    messageCount: 6,
    botInteractions: 3,
    sessionAgeMs: 8 * 60_000,
    recentHumanTurns: 3,
    responseLatencyMs: 20_000,
    directInteraction: true,
    message: 'nice play',
  };
  const noQuestions = retentionOpportunityScore({ ...base, recentBotQuestions: 0 });
  const fatigued = retentionOpportunityScore({ ...base, recentBotQuestions: 2 });

  assert.ok(fatigued < noQuestions);
  assert.equal(canAskQuestion({ recentBotQuestions: 2 }), false);
  assert.equal(canAskQuestion({ recentBotQuestions: 0 }), true);
});

test('retention never stacks with welcome, follow CTA, sales, or opt-out', async () => {
  RetentionStore.clearMemoryForTests();
  const engine = new ConversationRetentionEngine({ enabled: true, rng: seeded(), minScore: 0.2 });
  const now = 2_000_000;
  const profile = engagedProfile(now);

  for (const scenario of [
    { proactiveWelcome: true, reason: 'trust_priority' },
    { offerFollow: true, reason: 'trust_priority' },
    { salesEligible: true, reason: 'trust_priority' },
  ]) {
    const result = await engine.select({
      channel: '#saevond',
      viewer: 'alice',
      profile,
      message: '@clanker nice play',
      directInteraction: true,
      history: [],
      now,
      ...scenario,
    });
    assert.equal(result.eligible, false);
    assert.equal(result.reason, scenario.reason);
  }

  const opted = await engine.select({
    channel: '#saevond',
    viewer: 'alice',
    profile: { ...profile, proactiveOptOut: true },
    message: '@clanker nice play',
    directInteraction: true,
    history: [],
    now,
  });
  assert.equal(opted.eligible, false);
  assert.equal(opted.reason, 'opt_out');
});

test('45-second prompt gap prevents interrogating fast back-and-forth viewers', async () => {
  RetentionStore.clearMemoryForTests();
  const engine = new ConversationRetentionEngine({
    enabled: true,
    minScore: 0.2,
    minPromptGapMs: 45_000,
    rng: seeded(),
  });
  const now = 3_000_000;
  const result = await engine.select({
    channel: '#saevond',
    viewer: 'alice',
    profile: { ...engagedProfile(now), lastRetentionPromptAt: now - 20_000 },
    message: '@clanker that was wild',
    directInteraction: true,
    history: [],
    now,
  });

  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'prompt_gap');
});

test('question-saturated history forces a no-question retention turn', async () => {
  RetentionStore.clearMemoryForTests();
  const engine = new ConversationRetentionEngine({
    enabled: true,
    minScore: 0.2,
    minPromptGapMs: 1,
    rng: seeded(),
  });
  const now = 4_000_000;
  const history = [
    { role: 'assistant', content: 'Push or reset?', ts: now - 90_000 },
    { role: 'user', username: 'alice', content: 'push', ts: now - 80_000 },
    { role: 'assistant', content: 'Same weapon next fight?', ts: now - 60_000 },
    { role: 'user', username: 'alice', content: 'yeah', ts: now - 50_000 },
  ];

  const selection = await engine.select({
    channel: '#saevond',
    viewer: 'alice',
    profile: { ...engagedProfile(now), lastRetentionPromptAt: now - 50_000 },
    message: '@clanker lol',
    directInteraction: true,
    history,
    streamContext: { gameName: 'ARC Raiders' },
    now,
  });

  assert.equal(selection.eligible, true);
  assert.equal(selection.questionAllowed, false);
  assert.match(selection.instruction, /Do not ask a question this turn/i);
});

test('reply attribution rewards a strategy once inside 120 seconds', async () => {
  RetentionStore.clearMemoryForTests();
  const engine = new ConversationRetentionEngine({
    enabled: true,
    replyWindowMs: 120_000,
    rng: seeded(),
  });

  const selection = {
    eligible: true,
    strategy: 'reflect',
    banditScore: 0.5,
  };
  await engine.recordImpression({
    channel: '#saevond',
    viewer: 'alice',
    selection,
    at: 10_000,
  });

  const first = await engine.recordReply({
    channel: '#saevond',
    viewer: 'alice',
    at: 70_000,
  });
  assert.equal(first.attributed, true);
  assert.equal(first.strategy, 'reflect');
  assert.equal(first.latencyMs, 60_000);

  const second = await engine.recordReply({
    channel: '#saevond',
    viewer: 'alice',
    at: 80_000,
  });
  assert.equal(second.attributed, false);

  const stats = await RetentionStore.getStrategyStats('reflect');
  assert.equal(stats.impressions, 1);
  assert.equal(stats.replies, 1);
});

test('late replies do not receive false retention credit', async () => {
  RetentionStore.clearMemoryForTests();
  const engine = new ConversationRetentionEngine({
    enabled: true,
    replyWindowMs: 120_000,
    rng: seeded(),
  });

  await engine.recordImpression({
    channel: '#saevond',
    viewer: 'alice',
    selection: { eligible: true, strategy: 'humor' },
    at: 10_000,
  });
  const result = await engine.recordReply({
    channel: '#saevond',
    viewer: 'alice',
    at: 131_000,
  });
  assert.equal(result.attributed, false);
  assert.equal(result.reason, 'expired');

  const stats = await RetentionStore.getStrategyStats('humor');
  assert.equal(stats.impressions, 1);
  assert.equal(stats.replies, 0);
});

test('local backup-circuit retention follows the selected style without over-questioning', () => {
  const engine = new ConversationRetentionEngine({ enabled: true });
  assert.match(engine.localFallback({
    username: 'alice',
    message: 'lol',
    strategy: 'humor',
  }), /@alice/);

  const noQuestion = engine.localFallback({
    username: 'alice',
    message: 'nice timing',
    strategy: 'analysis',
    questionAllowed: false,
  });
  assert.doesNotMatch(noQuestion, /\?/);

  const prediction = engine.localFallback({
    username: 'alice',
    message: 'what next',
    strategy: 'prediction',
    questionAllowed: true,
  });
  assert.match(prediction, /\?/);
});

test('90-day Thompson simulation learns the higher-response conversational style', () => {
  const random = seeded(0x901DA7A);
  const rates = {
    reflect: 0.24,
    humor: 0.34,
    analysis: 0.29,
    prediction: 0.41,
  };
  const stats = Object.fromEntries(
    RETENTION_STRATEGIES.map(strategy => [strategy, { impressions: 0, replies: 0 }])
  );

  const trials = 90 * 60;
  let bestSelectionsLast1000 = 0;
  let regret = 0;

  for (let i = 0; i < trials; i += 1) {
    const arms = RETENTION_STRATEGIES.map(strategy => {
      const row = stats[strategy];
      const scored = scoreRetentionArm({
        strategy,
        alpha: 1 + row.replies,
        beta: 4 + row.impressions - row.replies,
        context: { message: 'what happens next?', streamContext: { gameName: 'ARC Raiders' } },
        repeatedStrategy: false,
        questionAllowed: true,
        rng: random,
      });
      return { strategy, ...scored };
    }).sort((a, b) => b.score - a.score);

    const chosen = arms[0].strategy;
    stats[chosen].impressions += 1;
    if (random() < rates[chosen]) stats[chosen].replies += 1;

    regret += rates.prediction - rates[chosen];
    if (i >= trials - 1000 && chosen === 'prediction') bestSelectionsLast1000 += 1;
  }

  assert.ok(bestSelectionsLast1000 / 1000 > 0.7, 'bandit should heavily favor the strongest response strategy');
  assert.ok(regret / trials < 0.05, 'average synthetic response regret should stay bounded');

  console.log('RETENTION_90_DAY_SIMULATION=' + JSON.stringify({
    trials,
    bestSelectionsLast1000,
    bestSelectionRate: bestSelectionsLast1000 / 1000,
    averageRegret: regret / trials,
    stats,
  }));
});
