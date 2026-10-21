import test from 'node:test';
import assert from 'node:assert/strict';
import { joinWelcomeAuthMessage } from '../src/chat/joinWelcomeStatus.js';

test('authorization page confirms named welcomes only after the watcher is ready', () => {
  const message = joinWelcomeAuthMessage({ ready: true }, 'sweatyclanker');
  assert.match(message, /authorization succeeded/i);
  assert.match(message, /named join welcomes are ready/i);
});

test('authorization page gives moderator-role recovery steps for a 403', () => {
  const message = joinWelcomeAuthMessage({
    ready: false,
    failures: [{ channel: '#saevond', reason: 'bot_not_channel_moderator', status: 403 }],
  }, 'sweatyclanker');
  assert.match(message, /make @sweatyclanker a moderator in #saevond/i);
  assert.match(message, /retry automatically/i);
});

test('authorization page distinguishes a rejected token from missing moderator status', () => {
  const message = joinWelcomeAuthMessage({
    ready: false,
    disabledReason: 'twitch_unauthorized',
    failures: [{ channel: '#saevond', reason: 'twitch_unauthorized', status: 401 }],
  }, 'sweatyclanker');
  assert.match(message, /401/);
  assert.match(message, /moderator:read:chatters/);
  assert.doesNotMatch(message, /make @sweatyclanker a moderator/i);
});

test('authorization page does not claim readiness after a transient poll failure', () => {
  const message = joinWelcomeAuthMessage({
    ready: false,
    failures: [{ channel: '#saevond', reason: 'helix_poll_failed', status: 503 }],
  }, 'sweatyclanker');
  assert.match(message, /not available yet/i);
  assert.match(message, /retry automatically/i);
});
