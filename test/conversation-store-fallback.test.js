import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TWITCH_USERNAME ||= 'testbot';
process.env.TWITCH_CLIENT_ID ||= 'test-client';
process.env.TWITCH_CLIENT_SECRET ||= 'test-secret';
process.env.JOIN_CHANNELS ||= 'saevond';
process.env.DEEPSEEK_API_KEY ||= 'test-key';
process.env.REDIS_URL = '';

const { createConversationStore } = await import('../src/memory/conversationStore.js');
const { quietSpeakProbability } = await import('../src/chat/quietChatterModel.js');

test('Redis absence keeps bounded conversation history and human activity in process memory', async () => {
  let now = 1_000_000;
  const store = createConversationStore({
    redisProvider: () => null,
    now: () => now,
    logger: { warn() {} },
  });

  await store.pushMessage('#saevond', 'user', 'that parry was clean', 'alice');
  assert.equal(await store.getLastActivity('#saevond'), now);
  assert.deepEqual((await store.getHistory('#saevond', 10)).map(entry => entry.content), ['that parry was clean']);

  now += 60_000;
  assert.equal(quietSpeakProbability({
    silenceMs: now - await store.getLastActivity('#saevond'),
    tickMs: 30_000,
  }), 0, 'fresh chat activity must suppress quiet prompts');

  await store.pushMessage('#saevond', 'assistant', 'the timing was perfect');
  const history = await store.getHistory('#saevond', 10);
  assert.deepEqual(history.map(entry => entry.role), ['user', 'assistant']);
  assert.equal(history[0].username, 'alice');
});

test('Redis command failures fall back without losing reads or throwing through chat handling', async () => {
  let now = 2_000_000;
  const warnings = [];
  const failingRedis = {
    async lpush() { throw new Error('quota exceeded'); },
    async ltrim() { throw new Error('quota exceeded'); },
    async expire() { throw new Error('quota exceeded'); },
    async lrange() { throw new Error('quota exceeded'); },
    async get() { throw new Error('quota exceeded'); },
    async set() { throw new Error('quota exceeded'); },
  };
  const store = createConversationStore({
    redisProvider: () => failingRedis,
    now: () => now,
    logger: { warn(...args) { warnings.push(args); } },
  });

  await store.updateLastActivity('#saevond', now);
  await store.pushMessage('#saevond', 'user', 'gg', 'bob');
  now += 2_000;
  await store.pushMessage('#saevond', 'bot', 'one short prediction');

  assert.equal(await store.getLastActivity('#saevond'), 2_000_000);
  assert.deepEqual((await store.getHistory('#saevond', 10)).map(entry => entry.content), ['gg', 'one short prediction']);
  assert.equal(warnings.length, 1, 'one Redis failure should not flood logs');
});

test('Redis recovery merges persisted and process-local entries without duplicates', async () => {
  let now = 3_000_000;
  let unavailable = true;
  const lists = new Map();
  const values = new Map();
  const redis = {
    async lpush(key, value) {
      if (unavailable) throw new Error('temporarily unavailable');
      lists.set(key, [value, ...(lists.get(key) || [])]);
    },
    async ltrim(key, start, end) {
      lists.set(key, (lists.get(key) || []).slice(start, end + 1));
    },
    async expire() {},
    async lrange(key, start, end) {
      if (unavailable) throw new Error('temporarily unavailable');
      return (lists.get(key) || []).slice(start, end + 1);
    },
    async get(key) {
      if (unavailable) throw new Error('temporarily unavailable');
      return values.get(key) || null;
    },
    async set(key, value) {
      if (unavailable) throw new Error('temporarily unavailable');
      values.set(key, value);
    },
  };
  const store = createConversationStore({
    redisProvider: () => redis,
    now: () => now,
    logger: { warn() {} },
  });

  await store.pushMessage('#saevond', 'user', 'saved during outage', 'alice');
  unavailable = false;
  now += 500;
  await store.pushMessage('#saevond', 'assistant', 'saved after recovery');
  const history = await store.getHistory('#saevond', 10);

  assert.deepEqual(history.map(entry => entry.content), ['saved during outage', 'saved after recovery']);
  assert.equal(new Set(history.map(entry => entry.ts)).size, 2);
});

test('local history is capped at 100 entries and expires after the retention window', async () => {
  let now = 4_000_000;
  const store = createConversationStore({
    redisProvider: () => null,
    now: () => now,
    logger: { warn() {} },
  });

  for (let index = 0; index < 105; index += 1) {
    await store.pushMessage('#saevond', 'user', `message-${index}`, 'alice');
    now += 1;
  }

  const history = await store.getHistory('#saevond', 200);
  assert.equal(history.length, 100);
  assert.equal(history[0].content, 'message-5');
  now += 24 * 60 * 60 * 1000 + 10;
  assert.deepEqual(await store.getHistory('#saevond', 100), []);
  assert.equal(await store.getLastActivity('#saevond'), 0);
});
