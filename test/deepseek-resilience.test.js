import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

process.env.TWITCH_USERNAME ||= 'sweatyclanker';
process.env.TWITCH_CLIENT_ID ||= 'test-client';
process.env.TWITCH_CLIENT_SECRET ||= 'test-secret';
process.env.JOIN_CHANNELS ||= 'saevond';
process.env.DEEPSEEK_API_KEY ||= 'test-key';
process.env.DEEPSEEK_MODEL ||= 'deepseek-chat';
process.env.REDIS_URL = '';

const { DeepSeekClient, DeepSeekUnavailableError } = await import('../src/ai/client.js');
const { getContextualFallbackResponse } = await import('../personality.js');

test('DeepSeek 402 fails fast after one request and activates billing block', async () => {
  const originalPost = axios.post;
  let calls = 0;
  axios.post = async () => {
    calls += 1;
    const err = new Error('payment required');
    err.response = { status: 402 };
    throw err;
  };

  try {
    const client = new DeepSeekClient();
    client.retries = 3;
    await assert.rejects(
      () => client.chat([{ role: 'user', content: 'hello' }]),
      err => err instanceof DeepSeekUnavailableError
        && err.status === 402
        && err.code === 'insufficient_balance',
    );
    assert.equal(calls, 1, '402 must not be retried');
    assert.equal(client.getHealth().billingBlocked, true);

    await assert.rejects(
      () => client.chat([{ role: 'user', content: 'hello again' }]),
      err => err instanceof DeepSeekUnavailableError && err.status === 402,
    );
    assert.equal(calls, 1, 'blocked client must not keep charging/retrying the provider');
  } finally {
    axios.post = originalPost;
  }
});

test('DeepSeek balance recovery resumes normal API calls automatically', async () => {
  const originalGet = axios.get;
  const originalPost = axios.post;
  const client = new DeepSeekClient();
  client.billingBlocked = true;
  client.nextBalanceCheckAt = 0;

  let balanceChecks = 0;
  let chatCalls = 0;
  axios.get = async url => {
    if (String(url).includes('/user/balance')) {
      balanceChecks += 1;
      return { status: 200, data: { is_available: true } };
    }
    return originalGet(url);
  };
  axios.post = async () => {
    chatCalls += 1;
    return {
      status: 200,
      data: {
        choices: [{ message: { content: 'Recovered response' } }],
        usage: { total_tokens: 5 },
      },
    };
  };

  try {
    const reply = await client.chat([{ role: 'user', content: 'hello' }]);
    assert.equal(reply, 'Recovered response');
    assert.equal(balanceChecks, 1);
    assert.equal(chatCalls, 1);
    assert.equal(client.getHealth().billingBlocked, false);
  } finally {
    axios.get = originalGet;
    axios.post = originalPost;
  }
});

test('local fallback answers common Twitch chat naturally during provider outage', () => {
  assert.match(getContextualFallbackResponse('How are you?', 'saevond'), /@saevond/);
  assert.match(getContextualFallbackResponse('How are you?', 'saevond'), /Operational/i);
  assert.match(getContextualFallbackResponse('@sweatyclanker', 'saevond'), /Sensors online/i);
  assert.match(getContextualFallbackResponse('lol that was clutch', 'viewer1'), /Chaos detected/i);
  assert.doesNotMatch(getContextualFallbackResponse('How are you?', 'saevond'), /Error 404|broke my processors/i);
});
