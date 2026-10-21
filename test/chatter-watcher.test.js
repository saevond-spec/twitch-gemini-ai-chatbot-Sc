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

test('401 disables polling and reports an authorization failure without guessing the cause', async () => {
  const watcher = new ChatterWatcher({
    helix: {
      async getUserByLogin() { return { id: 'broadcaster-1' }; },
      async getTokenOwnerId() { return 'moderator-1'; },
      async getChatters() {
        const err = new Error('unauthorized');
        err.response = { status: 401 };
        throw err;
      },
    },
    channels: ['saevond'],
    botLogin: 'sweatyclanker',
    pollMs: 30_000,
  });

  watcher.running = true;
  const result = await watcher.tick();
  assert.equal(watcher.disabledReason, 'twitch_unauthorized');
  assert.equal(result.failures[0].reason, 'twitch_unauthorized');
  assert.equal(watcher.getStatus().ready, false);
});

test('403 reports missing channel moderator status and retries without another OAuth callback', async () => {
  let isModerator = false;
  const watcher = new ChatterWatcher({
    helix: {
      async getUserByLogin() { return { id: 'broadcaster-1' }; },
      async getTokenOwnerId() { return 'moderator-1'; },
      async getChatters() {
        if (!isModerator) {
          const err = new Error('not a moderator');
          err.response = { status: 403 };
          throw err;
        }
        return [{ user_login: 'alice' }];
      },
    },
    channels: ['saevond'],
    botLogin: 'sweatyclanker',
  });

  watcher.running = true;
  const first = await watcher.tick();
  assert.equal(watcher.disabledReason, null);
  assert.equal(first.ready, false);
  assert.equal(first.failures[0].reason, 'bot_not_channel_moderator');

  isModerator = true;
  const recovered = await watcher.tick();
  assert.equal(recovered.ready, true);
  assert.deepEqual(recovered.failures, []);
});


test('OAuth scope upgrade resumes watcher, rebuilds baseline, and welcomes only future arrivals', async () => {
  const arrivals = [];
  let calls = 0;
  let now = 6_000_000;
  const watcher = new ChatterWatcher({
    helix: {
      async getUserByLogin(login) { return { id: 'broadcaster-1', login }; },
      async getTokenOwnerId() { return 'moderator-1'; },
      async getChatters() {
        calls += 1;
        if (calls === 1) {
          const err = new Error('unauthorized');
          err.response = { status: 401 };
          throw err;
        }
        if (calls === 2) return [{ user_login: 'alice' }, { user_login: 'bob' }];
        return [{ user_login: 'alice' }, { user_login: 'bob' }, { user_login: 'charlie' }];
      },
    },
    channels: ['saevond'],
    botLogin: 'sweatyclanker',
    ignoredUsers: [],
    now: () => now,
    onArrival: async event => arrivals.push(event),
  });

  watcher.running = true;
  await watcher.tick();
  assert.equal(watcher.disabledReason, 'twitch_unauthorized');

  const resumed = await watcher.resumeAfterAuthorization();
  assert.equal(resumed, true);
  assert.equal(watcher.disabledReason, null);
  assert.equal(arrivals.length, 0, 'existing chatters must become baseline after OAuth upgrade');

  now += 30_000;
  await watcher.tick();
  assert.deepEqual(arrivals.map(event => event.username), ['charlie']);
});

test('OAuth resume returns false on a transient baseline failure and recovers on the next poll', async () => {
  let calls = 0;
  const watcher = new ChatterWatcher({
    helix: {
      async getUserByLogin(login) { return { id: 'broadcaster-1', login }; },
      async getTokenOwnerId() { return 'moderator-1'; },
      async getChatters() {
        calls += 1;
        if (calls === 1) {
          const err = new Error('unauthorized');
          err.response = { status: 401 };
          throw err;
        }
        if (calls === 2) {
          const err = new Error('temporarily unavailable');
          err.response = { status: 503 };
          throw err;
        }
        return [{ user_login: 'alice' }];
      },
    },
    channels: ['saevond'],
    botLogin: 'sweatyclanker',
  });

  watcher.running = true;
  await watcher.tick();
  assert.equal(await watcher.resumeAfterAuthorization(), false);
  assert.equal(watcher.getStatus().ready, false);
  assert.equal(watcher.getStatus().failures[0].reason, 'helix_poll_failed');

  const recovered = await watcher.tick();
  assert.equal(recovered.ready, true);
});

test('OAuth resume waits for an in-flight unauthorized poll before rebuilding the baseline', async () => {
  let releaseFirstPoll;
  let markFirstPollStarted;
  const firstPollStarted = new Promise(resolve => { markFirstPollStarted = resolve; });
  const firstPollGate = new Promise(resolve => { releaseFirstPoll = resolve; });
  let calls = 0;
  const watcher = new ChatterWatcher({
    helix: {
      async getUserByLogin(login) { return { id: 'broadcaster-1', login }; },
      async getTokenOwnerId() { return 'moderator-1'; },
      async getChatters() {
        calls += 1;
        if (calls === 1) {
          markFirstPollStarted();
          await firstPollGate;
          const err = new Error('unauthorized');
          err.response = { status: 401 };
          throw err;
        }
        return [{ user_login: 'alice' }];
      },
    },
    channels: ['saevond'],
    botLogin: 'sweatyclanker',
  });

  watcher.running = true;
  const oldTick = watcher.tick();
  await firstPollStarted;
  const resume = watcher.resumeAfterAuthorization();
  releaseFirstPoll();

  await oldTick;
  assert.equal(await resume, true);
  assert.equal(calls, 2);
  assert.equal(watcher.getStatus().ready, true);
});
