import test from 'node:test';
import assert from 'node:assert/strict';
import {
  enabledWorkerQueues,
  estimatedMonthlyIdlePolls,
  workerRedisBudget,
} from '../src/queue/workerPolicy.js';

const queues = ['generate-clips', 'post-social', 'discord-announce', 'moderation-review'];

test('auto worker policy starts no idle workers when delivery features are disabled', () => {
  const env = {
    WORKERS_ENABLED: 'true',
    WORKER_QUEUES: 'auto',
    YOUTUBE_UPLOAD_ENABLED: 'false',
    TIKTOK_UPLOAD_ENABLED: 'false',
    DISCORD_ANNOUNCE_ENABLED: 'false',
  };
  assert.deepEqual(enabledWorkerQueues(queues, env), []);
});

test('auto worker policy starts only clip processing when a delivery destination is enabled', () => {
  const env = {
    WORKERS_ENABLED: 'true',
    WORKER_QUEUES: 'auto',
    YOUTUBE_UPLOAD_ENABLED: 'true',
    TIKTOK_UPLOAD_ENABLED: 'false',
    DISCORD_ANNOUNCE_ENABLED: 'false',
  };
  assert.deepEqual(enabledWorkerQueues(queues, env), ['generate-clips']);
});

test('explicit worker policy filters unknown queues and removes duplicates', () => {
  const env = {
    WORKERS_ENABLED: 'true',
    WORKER_QUEUES: 'generate-clips,moderation-review,generate-clips,not-real',
  };
  assert.deepEqual(enabledWorkerQueues(queues, env), ['generate-clips', 'moderation-review']);
});

test('workers disabled means no queues regardless of requested names', () => {
  const env = {
    WORKERS_ENABLED: 'false',
    WORKER_QUEUES: 'generate-clips',
  };
  assert.deepEqual(enabledWorkerQueues(queues, env), []);
});

test('free-tier worker budget defaults to long idle waits and slow stalled scans', () => {
  const budget = workerRedisBudget({});
  assert.equal(budget.drainDelaySeconds, 120);
  assert.equal(budget.stalledIntervalMs, 300_000);
});

test('four idle workers remain well under the old million-poll monthly pattern', () => {
  const budget = workerRedisBudget({});
  const polls = estimatedMonthlyIdlePolls(4, budget);
  assert.equal(polls, 120_960);
  assert.ok(polls < 125_000);
});

test('one necessary worker costs about thirty thousand idle checks per 30 days', () => {
  const budget = workerRedisBudget({});
  const polls = estimatedMonthlyIdlePolls(1, budget);
  assert.equal(polls, 30_240);
});

test('worker timing inputs are clamped to safe ranges', () => {
  assert.deepEqual(workerRedisBudget({
    BULLMQ_DRAIN_DELAY_SECONDS: '1',
    BULLMQ_STALLED_INTERVAL_SECONDS: '5',
  }), {
    drainDelaySeconds: 10,
    stalledIntervalMs: 30_000,
  });

  assert.deepEqual(workerRedisBudget({
    BULLMQ_DRAIN_DELAY_SECONDS: '9999',
    BULLMQ_STALLED_INTERVAL_SECONDS: '9999',
  }), {
    drainDelaySeconds: 600,
    stalledIntervalMs: 900_000,
  });
});
