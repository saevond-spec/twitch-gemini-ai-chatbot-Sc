import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageQueue } from '../src/queue/messageQueue.js';

const within = async (promise, ms, label) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

test('high-priority messages send immediately, retry refusal, and acknowledge only delivery', async t => {
  const attempts = [];
  let firstAttemptResolve;
  let deliveredResolve;
  const firstAttempt = new Promise(resolve => { firstAttemptResolve = resolve; });
  const delivered = new Promise(resolve => { deliveredResolve = resolve; });
  const client = {
    async say(channel, message) {
      attempts.push({ channel, message });
      if (attempts.length === 1) {
        firstAttemptResolve();
        return false;
      }
      return true;
    },
  };
  const queue = new MessageQueue(client, { pollIntervalMs: 10_000 });
  t.after(() => queue.stop());

  let acknowledgements = 0;
  queue.enqueue('#channel', 'welcome @viewer', {
    priority: 'high',
    onDelivered: () => {
      acknowledgements++;
      deliveredResolve();
    },
  });

  await within(firstAttempt, 1_500, 'high-priority welcome waited for the polling interval');
  assert.equal(acknowledgements, 0, 'refused delivery must not be acknowledged');

  await queue.process();
  await within(delivered, 1_500, 'requeued welcome was not delivered');
  assert.deepEqual(attempts, [
    { channel: '#channel', message: 'welcome @viewer' },
    { channel: '#channel', message: 'welcome @viewer' },
  ]);
  assert.equal(acknowledgements, 1);
});
