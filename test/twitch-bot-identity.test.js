import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TWITCH_USERNAME = 'sweatyclanker';
process.env.TWITCH_CLIENT_ID ||= 'test-client';
process.env.TWITCH_CLIENT_SECRET ||= 'test-secret';
process.env.JOIN_CHANNELS ||= 'saevond';
process.env.DEEPSEEK_API_KEY ||= 'test-key';
process.env.REDIS_URL = '';

const {
  BOT_SCOPES,
  configuredBotLogin,
  tokenBelongsToConfiguredBot,
} = await import('../src/twitch/auth.js');

test('configured Twitch bot identity is SweatyClanker', () => {
  assert.equal(configuredBotLogin(), 'sweatyclanker');
  assert.equal(tokenBelongsToConfiguredBot({ login: 'SweatyClanker' }), true);
  assert.equal(tokenBelongsToConfiguredBot({ login: 'saevond' }), false);
  assert.equal(tokenBelongsToConfiguredBot({ login: '' }), false);
});

test('bot OAuth scopes contain chat/clip access but no broadcaster monetization scopes', () => {
  assert.ok(BOT_SCOPES.includes('user:read:chat'));
  assert.ok(BOT_SCOPES.includes('user:write:chat'));
  assert.ok(BOT_SCOPES.includes('user:bot'));
  assert.ok(BOT_SCOPES.includes('channel:manage:clips'));
  assert.equal(BOT_SCOPES.includes('channel:read:subscriptions'), false);
  assert.equal(BOT_SCOPES.includes('bits:read'), false);
});
