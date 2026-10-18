import test from 'node:test';
import assert from 'node:assert/strict';
import { JoinWelcomeBatcher, formatJoinWelcome } from '../src/chat/joinWelcomeBatcher.js';

test('single incoming viewer gets a generic low-pressure welcome without being named', () => {
  const msg = formatJoinWelcome(['Alice']);
  assert.match(msg, /Welcome in/i);
  assert.match(msg, /chat whenever/i);
  assert.doesNotMatch(msg, /@alice/i);
});

test('multiple incoming viewers are welcomed together without exposing usernames', () => {
  const msg = formatJoinWelcome(['Alice', 'Bob', 'Charlie']);
  assert.match(msg, /Welcome in, everyone/i);
  assert.match(msg, /no pressure to type/i);
  assert.doesNotMatch(msg, /@alice|@bob|@charlie/i);
});

test('large arrival bursts welcome everybody without chat flooding or naming lurkers', () => {
  const names = Array.from({ length: 25 }, (_, i) => `viewer${i + 1}`);
  const msg = formatJoinWelcome(names);
  assert.match(msg, /Welcome in, everyone/i);
  assert.doesNotMatch(msg, /@viewer/i);
  assert.ok(msg.length < 180);
});

test('reconnect warmup prevents greeting the entire existing room', () => {
  let now = 1_000_000;
  const batcher = new JoinWelcomeBatcher({
    warmupMs: 20_000,
    now: () => now,
  });

  assert.equal(batcher.add('#saevond', 'alice', now + 5_000), false);
  now += 21_000;
  assert.equal(batcher.add('#saevond', 'alice', now), true);
  batcher.stop();
});

test('same viewer is only welcomed once during dedupe window', async () => {
  let now = 2_000_000;
  const sent = [];
  const batcher = new JoinWelcomeBatcher({
    flushMs: 1,
    warmupMs: 0,
    dedupeMs: 6 * 60 * 60 * 1000,
    now: () => now,
    onFlush: async (channel, message, names) => sent.push({ channel, message, names }),
  });

  assert.equal(batcher.add('#saevond', 'alice', now), true);
  await batcher.flush('#saevond');
  assert.equal(batcher.hasWelcomed('#saevond', 'alice', now + 1000), true);
  assert.equal(batcher.add('#saevond', 'alice', now + 1000), false);
  assert.equal(sent.length, 1);

  now += 6 * 60 * 60 * 1000 + 1;
  assert.equal(batcher.add('#saevond', 'alice', now), true);
  batcher.stop();
});

test('join welcome text never reveals silent usernames', () => {
  const msg = formatJoinWelcome(['alice', 'ALICE', 'bob']);
  assert.doesNotMatch(msg, /alice|bob|@/i);
});
