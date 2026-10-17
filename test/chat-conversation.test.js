import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldRespond } from '../personality.js';
import { IncomingMessageDeduper } from '../src/chat/incomingDeduper.js';
import { CooldownManager } from '../src/utils/cooldown.js';
import { MessageQueue } from '../src/queue/messageQueue.js';
import { buildUserPrompt } from '../src/ai/prompt.js';

test('multi-user chat only triggers SweatyClanker on mention or direct reply', () => {
  const aliases = ['sweatyclanker', 'clanker', 'sweaty clanker'];

  assert.equal(shouldRespond('gg that was wild', aliases, { username: 'alice' }), false);
  assert.equal(shouldRespond('@SweatyClanker what was that play?', aliases, { username: 'bob' }), true);
  assert.equal(shouldRespond('what do you think?', aliases, {
    username: 'charlie',
    'reply-parent-user-login': 'sweatyclanker',
  }), true);
  assert.equal(shouldRespond('same here', aliases, {
    username: 'dana',
    'reply-parent-user-login': 'alice',
  }), false);
});

test('duplicate Twitch PRIVMSG ids are ignored', () => {
  const deduper = new IncomingMessageDeduper(120000);
  const user = { username: 'alice', id: 'msg-123' };

  assert.equal(deduper.isDuplicate('#saevond', user), false);
  assert.equal(deduper.isDuplicate('#saevond', user), true);
  assert.equal(deduper.isDuplicate('#another', user), false);
});

test('cooldowns are isolated per channel and per user', () => {
  const realNow = Date.now;
  let now = 100000;
  Date.now = () => now;
  try {
    const cooldown = new CooldownManager({ global: 1, perUser: 5 });

    assert.equal(cooldown.check('#saevond:alice'), true);
    assert.equal(cooldown.check('#other:bob'), true, 'another channel should not be blocked');
    assert.equal(cooldown.check('#saevond:bob'), false, 'same channel should respect channel pacing');

    now += 1100;
    assert.equal(cooldown.check('#saevond:bob'), true);
    assert.equal(cooldown.check('#saevond:alice'), false, 'same user should still be in per-user cooldown');

    now += 4000;
    assert.equal(cooldown.check('#saevond:alice'), true);
  } finally {
    Date.now = realNow;
  }
});

test('outgoing queue preserves order and never sends two messages inside one-second channel window', async () => {
  const realNow = Date.now;
  let now = 200000;
  Date.now = () => now;
  const sent = [];
  const client = {
    say: async (channel, message) => {
      sent.push({ channel, message, at: Date.now() });
      return true;
    },
  };

  const queue = new MessageQueue(client);
  queue.stop();

  try {
    queue.enqueue('#saevond', 'reply to alice');
    queue.enqueue('#saevond', 'reply to bob');

    await queue.process();
    await queue.process();
    assert.deepEqual(sent.map(x => x.message), ['reply to alice']);

    now += 1099;
    await queue.process();
    assert.deepEqual(sent.map(x => x.message), ['reply to alice']);

    now += 1;
    await queue.process();
    assert.deepEqual(sent.map(x => x.message), ['reply to alice', 'reply to bob']);
  } finally {
    queue.stop();
    Date.now = realNow;
  }
});

test('DeepSeek user prompt does not duplicate channel history', () => {
  const prompt = buildUserPrompt('what did alice mean?', 'bob', [
    { role: 'user', username: 'alice', content: 'that clutch was crazy' },
  ]);

  assert.equal(prompt, 'bob: what did alice mean?');
  assert.doesNotMatch(prompt, /alice:/i);
});

test('simulated three-viewer conversation keeps surrounding chat as context while limiting bot triggers', () => {
  const aliases = ['sweatyclanker', 'clanker', 'sweaty clanker'];
  const transcript = [
    { user: 'alice', message: 'that parry was clean', tags: { id: 'm1' } },
    { user: 'bob', message: 'no way he lived there', tags: { id: 'm2' } },
    { user: 'charlie', message: '@clanker was that actually a good play?', tags: { id: 'm3' } },
    { user: 'bob', message: 'yeah explain it', tags: { id: 'm4', 'reply-parent-user-login': 'sweatyclanker' } },
    { user: 'alice', message: 'lol', tags: { id: 'm5' } },
  ];

  const decisions = transcript.map(entry => ({
    user: entry.user,
    respond: shouldRespond(entry.message, aliases, { username: entry.user, ...entry.tags }),
  }));

  assert.deepEqual(decisions, [
    { user: 'alice', respond: false },
    { user: 'bob', respond: false },
    { user: 'charlie', respond: true },
    { user: 'bob', respond: true },
    { user: 'alice', respond: false },
  ]);
});
