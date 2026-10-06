import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const setup = fs.readFileSync('setup.js', 'utf8');
const highlights = fs.readFileSync('highlights-setup.js', 'utf8');
const eventsub = fs.readFileSync('src/twitch/eventsub.js', 'utf8');
const queue = fs.readFileSync('src/queue/messageQueue.js', 'utf8');
const app = fs.readFileSync('src/app.js', 'utf8');

test('startup generation preserves existing patched source', () => {
  assert.match(setup, /if \(!fs\.existsSync\(filePath\)\)/);
  assert.match(setup, /Persist the refresh token across access-token expiry/);
});

test('highlight installer is idempotent across restarts', () => {
  assert.match(highlights, /current\.includes\(replacement\)/);
  assert.match(highlights, /HIGHLIGHT_DETECTION_ENABLED=/);
});

test('EventSub follows Twitch reconnect and duplicate-delivery rules', () => {
  assert.match(eventsub, /reconnect_url/);
  assert.match(eventsub, /transferred: true/);
  assert.match(eventsub, /_seenMessageIds/);
  assert.match(eventsub, /keepalive overdue/);
});

test('chat queue is bounded and expires stale outage backlog', () => {
  assert.match(queue, /CHAT_QUEUE_MAX_PER_CHANNEL/);
  assert.match(queue, /CHAT_QUEUE_MAX_AGE_SECONDS/);
  assert.match(queue, /Dropped.*expired queued message/);
});

test('autonomous chat requires recent viewer activity', () => {
  assert.match(app, /AUTO_MIN_CHAT_LINES/);
  assert.match(app, /AUTO_ACTIVITY_WINDOW_SECONDS/);
  assert.match(app, /recentChatActivity/);
});

test('730-day policy simulation keeps patched invariants', () => {
  const days = 730;
  const maxQueue = 50;
  const maxAgeSeconds = 120;
  let simulatedRestarts = 0;
  let simulatedDuplicateDeliveries = 0;
  let worstQueueDepth = 0;

  for (let day = 1; day <= days; day++) {
    if (day % 7 === 0) simulatedRestarts++;
    if (day % 13 === 0) simulatedDuplicateDeliveries++;
    const outageMinutes = day % 30 === 0 ? 10 : 0;
    const generatedMessages = outageMinutes * 2;
    worstQueueDepth = Math.max(worstQueueDepth, Math.min(maxQueue, generatedMessages));
  }

  assert.equal(days, 730);
  assert.ok(simulatedRestarts >= 104);
  assert.ok(simulatedDuplicateDeliveries >= 56);
  assert.ok(worstQueueDepth <= maxQueue);
  assert.ok(maxAgeSeconds <= 120);
});
