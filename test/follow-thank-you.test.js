import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFollowThankYou, FollowThankYouRotator, FOLLOW_THANK_YOU_VARIANTS } from '../src/chat/followThankYou.js';

test('follow thank-you mentions the follower and routes to the channel from EventSub', () => {
  assert.deepEqual(buildFollowThankYou({
    broadcaster_user_login: 'Saevond',
    user_login: 'NewViewer_42',
  }), {
    channel: '#saevond',
    viewer: 'newviewer_42',
    message: "Thanks for the follow, @newviewer_42!",
  });
});

test('follow thank-you rejects missing or unsafe Twitch logins', () => {
  assert.equal(buildFollowThankYou({ user_login: 'newviewer' }), null);
  assert.equal(buildFollowThankYou({
    broadcaster_user_login: 'saevond',
    user_login: 'viewer @everyone',
  }), null);
});

test('follow thank-yous are personal, concise, varied, and cycle after 75 lines', () => {
  const event = {
    broadcaster_user_login: 'Saevond',
    user_login: 'NewViewer_42',
  };
  const messages = Array.from({ length: 75 }, (_, index) => buildFollowThankYou(event, index).message);
  const templates = FOLLOW_THANK_YOU_VARIANTS;
  const openerPairs = templates.map(template => {
    const withoutViewer = template.replaceAll('@{{viewer}}', '').replaceAll('{{viewer}}', '');
    return (withoutViewer.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) || []).slice(0, 2).join(' ').toLowerCase();
  });
  const wordCounts = templates.map(template =>
    (template.replaceAll('@{{viewer}}', '').match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) || []).length
  );
  const averageWordCount = wordCounts.reduce((sum, count) => sum + count, 0) / wordCounts.length;
  const averageCharacterCount = messages.reduce((sum, message) => sum + message.length, 0) / messages.length;
  const emojiCount = templates.filter(template => /💛|😎|🤖|🎮|😂|😄|😅/u.test(template)).length;
  const cuhCount = templates.filter(template => /\bcuh\b/i.test(template)).length;

  assert.equal(templates.length, 75);
  assert.equal(new Set(templates).size, 75);
  assert.equal(new Set(messages).size, 75);
  assert.ok(messages.every(message => message.includes('@newviewer_42')));
  assert.ok(messages.every(message => /\b(thanks?|thank you|appreciat\w*|much love|good looking out)\b/i.test(message)));
  assert.ok(new Set(openerPairs).size >= 30);
  assert.ok(averageWordCount <= 9);
  assert.ok(averageCharacterCount <= 55);
  assert.ok(emojiCount <= 10);
  assert.ok(cuhCount >= 10 && cuhCount <= 20);
  assert.ok(Math.max(...messages.map(message => message.length)) < 500);
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
