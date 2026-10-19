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
    logger: { info() {}, warn() {} },
  });

  assert.equal(await router.chat([]), 'backup response');
  assert.equal(await router.chat([]), 'backup response');
  assert.equal(deepseekCalls, 1, 'known-down primary is skipped during failback cooldown');

  await new Promise(resolve => setTimeout(resolve, 1_050));
  failPrimary = false;
  assert.equal(await router.chat([]), 'primary recovered');
  assert.equal(router.getHealth().activeProvider, 'deepseek');
  assert.equal(deepseekCalls, 2);
  assert.equal(openaiCalls, 2);
});

