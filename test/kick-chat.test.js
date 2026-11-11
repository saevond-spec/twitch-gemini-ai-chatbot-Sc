import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeKickChatEvent } from '../src/kick/client.js';

test('normalizeKickChatEvent maps official Kick chat payload into SweatyClanker shape', () => {
  const event = normalizeKickChatEvent({
    message_id: 'msg-123',
    broadcaster: {
      user_id: 777,
      username: 'Saevond',
      channel_slug: 'saevond',
    },
    sender: {
      user_id: 42,
      username: 'ViewerName',
      channel_slug: 'viewername',
      identity: {
        badges: [{ type: 'moderator', text: 'Moderator' }],
      },
    },
    content: 'hey sweaty',
  });

  assert.equal(event.platform, 'kick');
  assert.equal(event.channel, 'saevond');
  assert.equal(event.broadcasterUserId, 777);
  assert.equal(event.user.username, 'viewername');
  assert.equal(event.user['display-name'], 'ViewerName');
  assert.equal(event.user.messageId, 'msg-123');
  assert.equal(event.user.mod, true);
  assert.equal(event.message, 'hey sweaty');
  assert.equal(event.self, false);
});

test('normalizeKickChatEvent tolerates sparse payloads without throwing', () => {
  const event = normalizeKickChatEvent({ content: 'hello' });
  assert.equal(event.platform, 'kick');
  assert.equal(event.message, 'hello');
  assert.equal(event.user.username, 'viewer');
  assert.equal(event.broadcasterUserId, null);
});
