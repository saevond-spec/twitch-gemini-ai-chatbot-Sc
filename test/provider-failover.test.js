import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

process.env.TWITCH_USERNAME ||= 'sweatyclanker';
process.env.TWITCH_CLIENT_ID ||= 'test-client';
process.env.TWITCH_CLIENT_SECRET ||= 'test-secret';
process.env.JOIN_CHANNELS ||= 'saevond';
process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';
process.env.DEEPSEEK_MODEL = 'deepseek-chat';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.REDIS_URL = '';

const { AIProviderRouter } = await import('../src/ai/providerRouter.js');
const { DeepSeekClient, OpenAIClient } = await import('../src/ai/client.js');

test('DeepSeek 402 immediately fails over to OpenAI chat completions', async () => {
  const originalPost = axios.post;
  const calls = [];
  let openAIPayload = null;
  let openAIConfig = null;

  axios.post = async (url, payload, requestConfig) => {
    calls.push(String(url));
    if (String(url).includes('api.deepseek.com')) {
      const error = new Error('payment required');
      error.response = { status: 402 };
      throw error;
    }

    openAIPayload = payload;
    openAIConfig = requestConfig;
    return {
      status: 200,
      data: {
        choices: [{ message: { content: 'Backup brain online.' } }],
      },
    };
  };

  try {
    const router = new AIProviderRouter({
      providers: [
        { name: 'deepseek', client: new DeepSeekClient() },
        { name: 'openai', client: new OpenAIClient() },
      ],
      providerOrder: ['deepseek', 'openai'],
      logger: { info() {}, warn() {} },
    });
    const reply = await router.chat(
      [{ role: 'user', content: 'Say hello.' }],
      { temperature: 0.7, maxTokens: 48 },
    );

    assert.equal(reply, 'Backup brain online.');
    assert.equal(calls.length, 2);
    assert.match(calls[0], /api\.deepseek\.com/);
    assert.match(calls[1], /api\.openai\.com\/v1\/chat\/completions/);
    assert.equal(openAIPayload.model, 'gpt-4.1-mini');
    assert.equal(openAIPayload.max_completion_tokens, 48);
    assert.equal(openAIPayload.temperature, 0.7);
    assert.equal(openAIConfig.headers.Authorization, 'Bearer test-openai-key');
    assert.equal(router.getHealth().activeProvider, 'openai');
  } finally {
    axios.post = originalPost;
  }
});

test('prompt-injection rejection does not send the message to another provider', async () => {
  let backupCalls = 0;
  const first = {
    async chat() {
      const error = new Error('Prompt injection detected');
      error.code = 'prompt_injection';
      error.canFailover = false;
      throw error;
    },
  };
  const backup = {
    async chat() {
      backupCalls++;
      return 'should not run';
    },
  };
  const router = new AIProviderRouter({
    providers: [
      { name: 'deepseek', client: first },
      { name: 'openai', client: backup },
    ],
    providerOrder: ['deepseek', 'openai'],
    logger: { info() {}, warn() {} },
  });

  await assert.rejects(
    () => router.chat([{ role: 'user', content: 'hello' }]),
    error => error.code === 'prompt_injection',
  );
  assert.equal(backupCalls, 0);
});

test('a recovered primary provider becomes active again', async () => {
  let now = 10_000;
  let deepseekCalls = 0;
  let openaiCalls = 0;
  let failPrimary = true;
  const deepseek = {
    async chat() {
      deepseekCalls++;
      if (failPrimary) {
        const error = new Error('unavailable');
        error.code = 'provider_unavailable';
        error.retryable = true;
        throw error;
      }
      return 'primary recovered';
    },
  };
  const openai = {
    async chat() {
      openaiCalls++;
      return 'backup response';
    },
  };
  const router = new AIProviderRouter({
    providers: [
      { name: 'deepseek', client: deepseek },
      { name: 'openai', client: openai },
    ],
    providerOrder: ['deepseek', 'openai'],
    failbackIntervalMs: 1_000,
    maxFailbackIntervalMs: 4_000,
    now: () => now,
    random: () => 0.5,
    logger: { info() {}, warn() {} },
  });

  assert.equal(await router.chat([]), 'backup response');
  assert.equal(await router.chat([]), 'backup response');
  assert.equal(deepseekCalls, 1, 'known-down primary is skipped during failback cooldown');

  now += 1_000;
  failPrimary = false;
  assert.equal(await router.chat([]), 'primary recovered');
  assert.equal(router.getHealth().activeProvider, 'deepseek');
  assert.equal(deepseekCalls, 2);
  assert.equal(openaiCalls, 2);
});

test('all-down provider cooldown prevents a retry on every chat message and backs off', async () => {
  let now = 10_000;
  const calls = { deepseek: 0, openai: 0 };
  const makeUnavailable = name => ({
    async chat() {
      calls[name] += 1;
      const error = new Error('upstream unavailable');
      error.status = 503;
      error.code = 'provider_unavailable';
      error.retryable = true;
      throw error;
    },
  });

  const router = new AIProviderRouter({
    providers: [
      { name: 'deepseek', client: makeUnavailable('deepseek') },
      { name: 'openai', client: makeUnavailable('openai') },
    ],
    providerOrder: ['deepseek', 'openai'],
    failbackIntervalMs: 1_000,
    maxFailbackIntervalMs: 4_000,
    now: () => now,
    random: () => 0.5,
  });

  await assert.rejects(() => router.chat([]), error => error.retryable === true);
  assert.deepEqual(calls, { deepseek: 1, openai: 1 });
  assert.equal(router.getHealth().available, false);

  now += 500;
  await assert.rejects(
    () => router.chat([]),
    error => error.code === 'provider_cooldown' && error.retryAfterMs === 500,
  );
  assert.deepEqual(calls, { deepseek: 1, openai: 1 }, 'cooldown requests make no provider calls');

  now += 500;
  await assert.rejects(() => router.chat([]), error => error.retryable === true);
  assert.deepEqual(calls, { deepseek: 2, openai: 2 });

  now += 1_000;
  await assert.rejects(
    () => router.chat([]),
    error => error.code === 'provider_cooldown' && error.retryAfterMs === 1_000,
  );
  assert.deepEqual(calls, { deepseek: 2, openai: 2 });

  now += 1_000;
  await assert.rejects(() => router.chat([]), error => error.retryable === true);
  assert.deepEqual(calls, { deepseek: 3, openai: 3 });
});

