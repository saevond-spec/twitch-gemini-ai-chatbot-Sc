import test from 'node:test';
import assert from 'node:assert/strict';
import { JoinWelcomeBatcher, formatJoinWelcome } from '../src/chat/joinWelcomeBatcher.js';

test('single incoming viewer gets a named low-pressure welcome', () => {
  const msg = formatJoinWelcome(['Alice']);
  assert.match(msg, /Welcome in @alice/i);
  assert.match(msg, /chat whenever/i);
});

test('multiple incoming viewers are welcomed together by username', () => {
  const msg = formatJoinWelcome(['Alice', 'Bob', 'Charlie']);
  assert.match(msg, /@alice/);
  assert.match(msg, /@bob/);
  assert.match(msg, /@charlie/);
  assert.match(msg, /Glad you're all here/);
});

test('large arrival bursts batch named welcomes without flooding chat', () => {
  const names = Array.from({ length: 25 }, (_, i) => `viewer${i + 1}`);
  const msg = formatJoinWelcome(names);
  assert.match(msg, /@viewer1/);
  assert.match(msg, /and 17 more/);
  assert.ok(msg.length < 500);
});

test('a viewer arriving immediately after startup is not silently dropped', () => {
  const batcher = new JoinWelcomeBatcher({
    flushMs: 60_000,
    now: () => 1_000_000,
  });

  assert.equal(batcher.add('#saevond', 'alice'), true);
  assert.equal(batcher.hasWelcomed('#saevond', 'alice'), true);
  batcher.stop();
});

test('same viewer is only welcomed once during dedupe window', async () => {
  let now = 2_000_000;
  const sent = [];
  const batcher = new JoinWelcomeBatcher({
    flushMs: 1,
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

test('join welcome batch removes duplicate usernames', () => {
  const msg = formatJoinWelcome(['alice', 'ALICE', 'bob']);
  assert.equal((msg.match(/@alice/g) || []).length, 1);
  assert.equal((msg.match(/@bob/g) || []).length, 1);
});
