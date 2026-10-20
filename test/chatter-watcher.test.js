import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatterWatcher } from '../src/twitch/chatterWatcher.js';

function makeHelix(sequence = []) {
  let index = 0;
  return {
    async getUserByLogin(login) {
      return { id: 'broadcaster-1', login };
    },
    async getTokenOwnerId() {
      return 'moderator-1';
    },
    async getChatters() {
      const value = sequence[Math.min(index, sequence.length - 1)] || [];
      index += 1;
      return value.map(user_login => ({ user_login }));
    },
  };
}

test('first Get Chatters snapshot becomes a baseline and never welcomes existing users', async () => {
  const arrivals = [];
  let now = 1_000_000;
  const watcher = new ChatterWatcher({
    helix: makeHelix([['alice', 'bob']]),
    channels: ['saevond'],
    botLogin: 'sweatyclanker',
    ignoredUsers: [],
    pollMs: 30_000,
    now: () => now,
    onArrival: async event => arrivals.push(event),
  });

  const result = await watcher.pollChannel('#saevond');
  assert.equal(result.baseline, true);
  assert.deepEqual(result.arrivals, []);
  assert.equal(arrivals.length, 0);
});

test('a newly observed chatter after baseline is welcomed exactly once', async () => {
  const arrivals = [];
  let now = 2_000_000;
  const watcher = new ChatterWatcher({
    helix: makeHelix([
      ['alice'],
      ['alice', 'bob'],
      ['alice', 'bob'],
    ]),
    channels: ['saevond'],
    botLogin: 'sweatyclanker',
    ignoredUsers: [],
    pollMs: 30_000,
    now: () => now,
    onArrival: async event => arrivals.push(event),
  });

  await watcher.pollChannel('#saevond');
  now += 30_000;
  const second = await watcher.pollChannel('#saevond');
  now += 30_000;
  const third = await watcher.pollChannel('#saevond');

  assert.deepEqual(second.arrivals, ['bob']);
  assert.deepEqual(third.arrivals, []);
  assert.equal(arrivals.length, 1);
  assert.equal(arrivals[0].username, 'bob');
  assert.equal(arrivals[0].source, 'helix-chatters');
});

test('IRC join observation suppresses a duplicate API welcome', async () => {
  const arrivals = [];
  let now = 3_000_000;
  const watcher = new ChatterWatcher({
    helix: makeHelix([
      ['alice'],
      ['alice', 'bob'],
    ]),
    channels: ['saevond'],
    botLogin: 'sweatyclanker',
    ignoredUsers: [],
    pollMs: 30_000,
    now: () => now,
    onArrival: async event => arrivals.push(event),
  });

  await watcher.pollChannel('#saevond');
  now += 10_000;
  watcher.observeIrcJoin('#saevond', 'bob', now);
  now += 20_000;
  const result = await watcher.pollChannel('#saevond');

  assert.deepEqual(result.arrivals, []);
  assert.equal(arrivals.length, 0);
});

test('temporary chatter-list disappearance does not create a duplicate welcome', async () => {
  const arrivals = [];
  let now = 4_000_000;
  const watcher = new ChatterWatcher({
    helix: makeHelix([
      ['alice'],
      ['alice', 'bob'],
      ['alice'],
      ['alice', 'bob'],
    ]),
    channels: ['saevond'],
    botLogin: 'sweatyclanker',
    ignoredUsers: [],
    pollMs: 30_000,
    rejoinSuppressMs: 30 * 60_000,
    now: () => now,
    onArrival: async event => arrivals.push(event),
  });

  await watcher.pollChannel('#saevond');
  now += 30_000;
  await watcher.pollChannel('#saevond');
  now += 30_000;
  await watcher.pollChannel('#saevond');
  now += 30_000;
  const reappear = await watcher.pollChannel('#saevond');

  assert.equal(arrivals.length, 1);
  assert.deepEqual(reappear.arrivals, []);
});

test('bot, broadcaster, ignored users, and service bots are never welcomed from API snapshots', async () => {
  const arrivals = [];
  let now = 5_000_000;
  const watcher = new ChatterWatcher({
    helix: makeHelix([
      ['alice'],
      ['alice', 'sweatyclanker', 'saevond', 'nightbot', 'customhelper', 'realviewer'],
    ]),
    channels: ['saevond'],
    botLogin: 'sweatyclanker',
    ignoredUsers: ['customhelper'],
    now: () => now,
    onArrival: async event => arrivals.push(event),
  });

  await watcher.pollChannel('#saevond');
  now += 30_000;
  const result = await watcher.pollChannel('#saevond');

  assert.deepEqual(result.arrivals, ['realviewer']);
  assert.deepEqual(arrivals.map(x => x.username), ['realviewer']);
});

test('401/403 disables polling until updated OAuth scope is granted', async () => {
  const watcher = new ChatterWatcher({
    helix: {
      async getUserByLogin() { return { id: 'broadcaster-1' }; },
      async getTokenOwnerId() { return 'moderator-1'; },
      async getChatters() {
        const err = new Error('missing scope');
        err.response = { status: 401 };
        throw err;
      },
    },
    channels: ['saevond'],
    botLogin: 'sweatyclanker',
    pollMs: 30_000,
  });

  watcher.running = true;
  await watcher.tick();
  assert.equal(watcher.disabledReason, 'missing_moderator_read_chatters');
});
