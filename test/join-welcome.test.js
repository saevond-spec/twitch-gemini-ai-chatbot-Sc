import test from 'node:test';
import assert from 'node:assert/strict';
import { JoinWelcomeBatcher, formatJoinWelcome } from '../src/chat/joinWelcomeBatcher.js';

test('join welcomes use a short batching window and one-minute rejoin dedupe', () => {
  const batcher = new JoinWelcomeBatcher();
  assert.equal(batcher.flushMs, 100);
  assert.equal(batcher.dedupeMs, 60_000);
  batcher.stop();
});

test('single-viewer greetings rotate through distinct cuh-flavored lines', () => {
  const greetings = Array.from({ length: 5 }, (_, index) => formatJoinWelcome(['Alice'], index));
  assert.equal(new Set(greetings).size, 5);
  assert.ok(greetings.every(message => message.includes('@alice') && message.includes('cuh')));
});

test('group greetings also rotate without changing burst acknowledgement', () => {
  const greetings = Array.from({ length: 4 }, (_, index) => formatJoinWelcome(['Alice', 'Bob'], index));
  assert.equal(new Set(greetings).size, 4);
  assert.ok(greetings.every(message => message.includes('@alice') && message.includes('@bob') && message.includes('cuh')));
});

test('each channel rotates its greeting across consecutive join batches', async () => {
  const sent = [];
  const batcher = new JoinWelcomeBatcher({
    flushMs: 60_000,
    onFlush: async (_channel, message, _names, delivery) => {
      sent.push(message);
      delivery.onDelivered();
      return true;
    },
  });

  assert.equal(batcher.add('#saevond', 'alice'), true);
  await batcher.flush('#saevond');
  assert.equal(batcher.add('#saevond', 'bob'), true);
  await batcher.flush('#saevond');

  assert.notEqual(sent[0], sent[1]);
  batcher.stop();
});

test('single incoming viewer gets a named low-pressure welcome', () => {
  const msg = formatJoinWelcome(['Alice']);
  assert.match(msg, /@alice/i);
  assert.match(msg, /welcome/i);
  assert.match(msg, /cuh/i);
});

test('multiple incoming viewers are welcomed together by username', () => {
  const msg = formatJoinWelcome(['Alice', 'Bob', 'Charlie']);
  assert.match(msg, /@alice/);
  assert.match(msg, /@bob/);
  assert.match(msg, /@charlie/);
  assert.match(msg, /welcome/i);
  assert.match(msg, /cuh/i);
});

test('large arrival bursts batch named welcomes without flooding chat', () => {
  const names = Array.from({ length: 25 }, (_, i) => `viewer${i + 1}`);
  const msg = formatJoinWelcome(names);
  assert.match(msg, /@viewer1/);
  assert.match(msg, /and 17 more/);
  assert.ok(msg.length < 500);
});

test('a viewer arriving immediately after startup is retained and duplicate JOINs are coalesced', () => {
  const batcher = new JoinWelcomeBatcher({
    flushMs: 60_000,
    now: () => 1_000_000,
  });

  assert.equal(batcher.add('#saevond', 'alice'), true);
  assert.equal(batcher.hasWelcomed('#saevond', 'alice'), true);
  assert.equal(batcher.add('#saevond', 'ALICE'), false);
  batcher.stop();
});

test('dedupe starts only after delivery and expires after the configured window', async () => {
  let now = 2_000_000;
  const sent = [];
  const batcher = new JoinWelcomeBatcher({
    flushMs: 60_000,
    dedupeMs: 60_000,
    now: () => now,
    onFlush: async (channel, message, names, delivery) => {
      sent.push({ channel, message, names });
      delivery.onDelivered();
      return true;
    },
  });

  assert.equal(batcher.add('#saevond', 'alice', now), true);
  await batcher.flush('#saevond');
  assert.equal(batcher.hasWelcomed('#saevond', 'alice', now + 1000), true);
  assert.equal(batcher.add('#saevond', 'alice', now + 1000), false);
  assert.equal(sent.length, 1);

  now += 60_001;
  assert.equal(batcher.add('#saevond', 'alice', now), true);
  batcher.stop();
});

test('a failed join welcome is retryable on the next JOIN', async () => {
  let delivery;
  const batcher = new JoinWelcomeBatcher({
    flushMs: 60_000,
    onFlush: async (_channel, _message, _names, callbacks) => {
      delivery = callbacks;
      return true;
    },
  });

  assert.equal(batcher.add('#saevond', 'alice'), true);
  await batcher.flush('#saevond');
  assert.equal(batcher.hasWelcomed('#saevond', 'alice'), true);

  delivery.onFailed();
  assert.equal(batcher.hasWelcomed('#saevond', 'alice'), false);
  assert.equal(batcher.add('#saevond', 'alice'), true);

  await batcher.flush('#saevond');
  delivery.onDelivered();
  assert.equal(batcher.hasWelcomed('#saevond', 'alice'), true);
  batcher.stop();
});

test('join welcome batch removes duplicate usernames', () => {
  const msg = formatJoinWelcome(['alice', 'ALICE', 'bob']);
  assert.equal((msg.match(/@alice/g) || []).length, 1);
  assert.equal((msg.match(/@bob/g) || []).length, 1);
});
