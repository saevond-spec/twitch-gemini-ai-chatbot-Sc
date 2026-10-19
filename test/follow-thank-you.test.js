import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFollowThankYou, FollowThankYouRotator } from '../src/chat/followThankYou.js';

test('follow thank-you mentions the follower and routes to the channel from EventSub', () => {
  assert.deepEqual(buildFollowThankYou({
    broadcaster_user_login: 'Saevond',
    user_login: 'NewViewer_42',
  }), {
    channel: '#saevond',
    viewer: 'newviewer_42',
    message: "Thanks for the follow, @newviewer_42! Glad you're here, cuh 💛",
  });
});

test('follow thank-you rejects missing or unsafe Twitch logins', () => {
  assert.equal(buildFollowThankYou({ user_login: 'newviewer' }), null);
  assert.equal(buildFollowThankYou({
    broadcaster_user_login: 'saevond',
    user_login: 'viewer @everyone',
  }), null);
});

test('follow thank-yous provide 75 unique personalized lines before cycling', () => {
  const event = {
    broadcaster_user_login: 'Saevond',
    user_login: 'NewViewer_42',
  };
  const messages = Array.from({ length: 75 }, (_, index) => buildFollowThankYou(event, index).message);

  assert.equal(new Set(messages).size, 75);
  assert.ok(messages.every(message => message.includes('@newviewer_42') && message.includes('cuh')));
  assert.equal(buildFollowThankYou(event, 75).message, messages[0]);
});

test('follow thank-you rotation advances per channel and ignores invalid events', () => {
  const rotator = new FollowThankYouRotator();
  const saevond = { broadcaster_user_login: 'saevond', user_login: 'newviewer' };
  const other = { broadcaster_user_login: 'otherchannel', user_login: 'newviewer' };

  assert.equal(rotator.build({ user_login: 'newviewer' }), null);
  const first = rotator.build(saevond);
  const second = rotator.build(saevond);
  const otherFirst = rotator.build(other);

  assert.notEqual(first.message, second.message);
  assert.equal(otherFirst.message, first.message);
});
