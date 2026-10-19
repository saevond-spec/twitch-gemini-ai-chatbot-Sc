import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFollowThankYou } from '../src/chat/followThankYou.js';

test('follow thank-you mentions the follower and routes to the channel from EventSub', () => {
  assert.deepEqual(buildFollowThankYou({
    broadcaster_user_login: 'Saevond',
    user_login: 'NewViewer_42',
  }), {
    channel: '#saevond',
    viewer: 'newviewer_42',
    message: "Thanks for the follow, @newviewer_42! Glad you're here 💛",
  });
});

test('follow thank-you rejects missing or unsafe Twitch logins', () => {
  assert.equal(buildFollowThankYou({ user_login: 'newviewer' }), null);
  assert.equal(buildFollowThankYou({
    broadcaster_user_login: 'saevond',
    user_login: 'viewer @everyone',
  }), null);
});
