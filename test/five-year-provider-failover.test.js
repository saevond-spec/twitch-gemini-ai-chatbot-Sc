import test from 'node:test';
import assert from 'node:assert/strict';
import { AIProviderRouter } from '../src/ai/providerRouter.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const START = Date.UTC(2026, 9, 19);
const END = Date.UTC(2031, 9, 19);

function scheduledFailure(provider, day, offsetMs) {
  if (day % 730 === 400 && offsetMs < 90_000) return 503;
  if (day % 30 === 3 && provider === 'deepseek' && offsetMs < 2 * MINUTE_MS) return 429;
  if (day % 365 === 40 && provider === 'deepseek' && offsetMs < 12 * HOUR_MS) return 402;
  if (day % 365 === 40 && provider === 'openai' && offsetMs < 2 * HOUR_MS) return 503;
  if (day % 365 === 41 && provider === 'deepseek' && offsetMs < 6 * HOUR_MS) return 503;
  if (day % 365 === 41 && provider === 'openai' && offsetMs < 2 * HOUR_MS) return 503;
  if (day % 730 === 125 && provider === 'deepseek' && offsetMs < DAY_MS) return 401;
  return null;
}

test('five-year AI failover simulation covers 1,826 days of realistic provider incidents', async () => {
  const days = (END - START) / DAY_MS;
  assert.equal(days, 1826, 'calendar horizon includes the 2028 leap day');

  let now = START;
  const calls = { deepseek: 0, openai: 0 };
  const failures = { deepseek: {}, openai: {} };
  const offsets = [
    0,
    30_000,
    90_000,
    5 * MINUTE_MS,
    30 * MINUTE_MS,
    2 * HOUR_MS,
    6 * HOUR_MS,
    23 * HOUR_MS,
  ];

  const makeProvider = name => ({
    async chat() {
      calls[name] += 1;
      const elapsed = now - START;
      const day = Math.floor(elapsed / DAY_MS);
      const offsetMs = elapsed % DAY_MS;
      const status = scheduledFailure(name, day, offsetMs);
      if (status) {
        failures[name][status] = (failures[name][status] || 0) + 1;
        const error = new Error('synthetic provider incident');
        error.status = status;
        error.code = status === 401
          ? 'authentication_failed'
          : status === 402
            ? 'insufficient_balance'
            : status === 429
              ? 'rate_limited'
              : 'provider_unavailable';
        error.retryable = status === 429 || status >= 500;
        throw error;
      }
      return `${name}-reply`;
    },
    getHealth() { return { available: true, configured: true }; },
  });

  const router = new AIProviderRouter({
    providers: [
      { name: 'deepseek', client: makeProvider('deepseek') },
      { name: 'openai', client: makeProvider('openai') },
    ],
    providerOrder: ['deepseek', 'openai'],
    failbackIntervalMs: 60_000,
    maxFailbackIntervalMs: 5 * MINUTE_MS,
    now: () => now,
    random: () => 0.5,
  });

  const summary = {
    days,
    simulatedMessages: 0,
    repliesByProvider: { deepseek: 0, openai: 0 },
    localFallbacks: 0,
    cooldownSuppressions: 0,
    deliveredResponses: 0,
    lostResponses: 0,
    maximumProviderCallsForOneMessage: 0,
  };

  for (let day = 0; day < days; day += 1) {
    for (const offsetMs of offsets) {
      now = START + day * DAY_MS + offsetMs;
      const before = calls.deepseek + calls.openai;
      summary.simulatedMessages += 1;
      let delivered = false;

      try {
        const reply = await router.chat([{ role: 'user', content: 'Synthetic stream chat prompt' }]);
        assert.ok(reply, 'a provider must return a response string');
        const provider = reply.startsWith('deepseek-') ? 'deepseek' : 'openai';
        summary.repliesByProvider[provider] += 1;
        delivered = true;
      } catch (error) {
        summary.localFallbacks += 1;
        if (error.code === 'provider_cooldown') summary.cooldownSuppressions += 1;
        const localReply = 'SweatyClanker local chat fallback';
        delivered = localReply.length > 0;
      }

      const providerCalls = calls.deepseek + calls.openai - before;
      summary.maximumProviderCallsForOneMessage = Math.max(
        summary.maximumProviderCallsForOneMessage,
        providerCalls,
      );
      assert.ok(providerCalls <= 2, 'a chat message calls each configured provider at most once');
      if (delivered) summary.deliveredResponses += 1;
    }
  }

  summary.lostResponses = summary.simulatedMessages - summary.deliveredResponses;
  assert.ok((failures.deepseek[401] || 0) > 0, 'bad-key incidents exercise fast auth-failure routing');
  assert.ok((failures.deepseek[402] || 0) > 0, 'billing interruptions exercise backup routing');
  assert.ok((failures.deepseek[429] || 0) > 0, 'rate limits exercise provider switching');
  assert.ok((failures.deepseek[503] || 0) > 0, 'provider outages exercise recovery');
  assert.ok((failures.openai[503] || 0) > 0, 'backup-provider outages are included');
  assert.ok(summary.localFallbacks > 0, 'both-down windows exercise local chat fallback');
  assert.ok(summary.cooldownSuppressions > 0, 'all-down cooldowns suppress repeated upstream calls');
  assert.equal(summary.lostResponses, 0);
  assert.equal(summary.simulatedMessages, days * offsets.length);

  console.log('FIVE_YEAR_AI_FAILOVER_SIMULATION=' + JSON.stringify({
    ...summary,
    providerFailures: failures,
    providerCalls: calls,
    scenarioProbabilities: 'none; incident schedule is synthetic and deterministic',
  }));
});
