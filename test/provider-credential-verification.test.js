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

test('provider credential check authenticates with read-only endpoints and returns no secrets or balance data', async () => {
  const originalGet = axios.get;
  const requests = [];
  axios.get = async (url, options) => {
    requests.push({ url: String(url), authorization: options.headers.Authorization });
    if (String(url) === 'https://api.deepseek.com/user/balance') {
      return {
        status: 200,
        data: {
          is_available: false,
          balance_infos: [{ total_balance: '9876.54', granted_balance: '0', topped_up_balance: '9876.54' }],
        },
      };
    }
    if (String(url) === 'https://api.openai.com/v1/models') {
      return { status: 200, data: { data: [{ id: 'private-project-model-list' }] } };
    }
    throw new Error('unexpected provider URL');
  };

  try {
    const router = new AIProviderRouter({
      providers: [
        { name: 'deepseek', client: new DeepSeekClient() },
        { name: 'openai', client: new OpenAIClient() },
      ],
      providerOrder: ['deepseek', 'openai'],
    });
    const reports = await router.verifyCredentials();
    const deepseek = reports.find(report => report.provider === 'deepseek');
    const openai = reports.find(report => report.provider === 'openai');

    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map(request => request.url).sort(), [
      'https://api.deepseek.com/user/balance',
      'https://api.openai.com/v1/models',
    ]);
    assert.ok(requests.every(request => request.authorization.startsWith('Bearer test-')));
    assert.equal(deepseek.authentication, 'verified');
    assert.equal(deepseek.accountAvailable, false);
    assert.equal(openai.authentication, 'verified');
    assert.equal(openai.httpStatus, 200);
    assert.doesNotMatch(JSON.stringify(reports), /test-(?:deepseek|openai)-key|9876\.54|private-project-model-list/);
  } finally {
    axios.get = originalGet;
  }
});

test('401 credential check reports rejection without echoing the provider response', async () => {
  const originalGet = axios.get;
  axios.get = async () => {
    const error = new Error('unauthorized response must not be returned');
    error.response = { status: 401, data: { message: 'test-openai-key is invalid' } };
    throw error;
  };

  try {
    const client = new OpenAIClient();
    const result = await client.verifyCredentials();
    assert.equal(result.authentication, 'rejected');
    assert.equal(result.httpStatus, 401);
    assert.equal(client.getHealth().credentialStatus, 'rejected');
    assert.doesNotMatch(JSON.stringify(result), /test-openai-key|unauthorized response/);
  } finally {
    axios.get = originalGet;
  }
});
