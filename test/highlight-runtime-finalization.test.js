import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.HIGHLIGHT_DETECTION_ENABLED = 'true';

async function loadHighlightDetector(t) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'highlight-runtime-test-'));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const detector = await fs.readFile(path.join(sourceRoot, 'src/highlights/detector.js'), 'utf8');
  const scoring = await fs.readFile(path.join(sourceRoot, 'src/highlights/scoring.js'), 'utf8');
  const helper = await fs.readFile(path.join(sourceRoot, 'highlight-window.js'), 'utf8');
  const files = {
    'package.json': JSON.stringify({ type: 'module' }),
    'node_modules/axios/package.json': JSON.stringify({ type: 'module', exports: './index.js' }),
    'node_modules/axios/index.js': "let getImpl = async () => ({ data: { data: [] } }); export function setGetImpl(fn) { getImpl = fn; } export default { get: (...args) => getImpl(...args) };",
    'src/config/index.js': "export const config = { twitch: { channels: ['saevond'], clientId: 'test-client' } };",
    'src/twitch/auth.js': "export function getAccessToken() { return 'test-token'; }",
    'src/storage/redis.js': "let redis = null; export function getRedis() { return redis; } export function setRedis(value) { redis = value; }",
    'src/logger/index.js': "export function createLogger() { return { info() {}, warn() {}, error() {} }; }",
    'src/bus/index.js': "const bus = { on() {}, off() {} }; export default bus;",
    'src/clips/twitchClipService.js': "export async function createClipFromVod() { return { id: 'stub', url: 'https://clips.twitch.tv/stub' }; }",
    'src/queue/index.js': "export async function enqueueTask() { return { id: 'stub' }; }",
    'src/highlights/scoring.js': scoring,
    'src/highlights/detector.js': detector,
    'highlight-window.js': helper
  };
  await Promise.all(Object.entries(files).map(async ([relative, contents]) => {
    const filePath = path.join(tempRoot, relative);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents);
  }));
  const moduleUrl = pathToFileURL(path.join(tempRoot, 'src/highlights/detector.js')).href;
  const loaded = await import(moduleUrl + '?test=' + Math.random());
  const redisModule = await import(pathToFileURL(path.join(tempRoot, 'src/storage/redis.js')).href);
  const axiosModule = await import(pathToFileURL(path.join(tempRoot, 'node_modules/axios/index.js')).href);
  loaded.HighlightDetector.testSetRedis = redisModule.setRedis;
  loaded.HighlightDetector.testSetAxiosGet = axiosModule.setGetImpl;
  return loaded.HighlightDetector;
}

function makeDetector(HighlightDetector, ai) {
  const detector = new HighlightDetector(ai);
  const scheduled = [];
  const scheduledIds = new Set();
  detector.restore = async () => {};
  detector.persist = async () => {};
  detector.scheduleFinalize = (snapshot) => {
    if (scheduledIds.has(snapshot.streamId)) return;
    scheduledIds.add(snapshot.streamId);
    scheduled.push(snapshot);
  };
  detector.helix = async (pathname) => pathname === '/streams' ? [] : [];
  return { detector, scheduled };
}

function startLiveStream(detector, { id = 'vod-old', startedAt = Date.now() - 60_000, messages = [] } = {}) {
  const state = detector.stateFor('saevond');
  Object.assign(state, {
    broadcasterId: 'broadcaster-1',
    live: true,
    ending: false,
    streamId: id,
    startedAt: new Date(startedAt).toISOString(),
    streamTitle: `Stream ${id}`,
    gameName: 'Game'
  });
  state.messages = messages;
  state.followEvents = [];
  state.candidates = [];
  state.lastAiAt = 0;
  return state;
}

test('the offline poll reviews quiet final chat at its observed timestamp before clearing it', async (t) => {
  const HighlightDetector = await loadHighlightDetector(t);
  const requests = [];
  const { detector, scheduled } = makeDetector(HighlightDetector, { chat: async (messages) => {
    requests.push(JSON.parse(messages[1].content));
    return JSON.stringify({ highlight: true, score: 82, title: 'Clutch finish',
      reason: 'Two viewers reacted to the final play', durationSeconds: 20 });
  } });
  const startedAt = Date.now() - 6 * 60 * 60 * 1000;
  const state = startLiveStream(detector, { startedAt, messages: [
    { at: startedAt + 119_000, username: 'viewer-a', message: 'That was close', excitement: 1 },
    { at: startedAt + 123_000, username: 'viewer-b', message: 'Nice play', excitement: 1 }
  ] });

  await detector.checkChannel(state);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].signals.finalWindow, true);
  assert.equal(requests[0].streamOffsetSeconds, 123);
  assert.equal(state.live, false);
  assert.equal(state.messages.length, 0);
  assert.equal(state.pendingFinalize, true);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].candidates[0].endSeconds, 128);
});

test('empty final chat schedules the VOD without inventing an AI candidate', async (t) => {
  const HighlightDetector = await loadHighlightDetector(t);
  let calls = 0;
  const { detector, scheduled } = makeDetector(HighlightDetector, { chat: async () => {
    calls += 1;
    return JSON.stringify({ highlight: true, score: 99, title: 'Invented', reason: 'None', durationSeconds: 20 });
  } });
  const startedAt = Date.now() - 10 * 60 * 1000;
  const state = startLiveStream(detector, { startedAt, messages: [
    { at: startedAt + 200_000, username: 'viewer', message: '   ', excitement: 0 }
  ] });

  await detector.checkChannel(state);

  assert.equal(calls, 0);
  assert.equal(state.live, false);
  assert.equal(state.pendingFinalize, true);
  assert.equal(scheduled.length, 1);
  assert.deepEqual(scheduled[0].candidates, []);
});

test('a failed final review preserves evidence for the next poll', async (t) => {
  const HighlightDetector = await loadHighlightDetector(t);
  let attempts = 0;
  const { detector } = makeDetector(HighlightDetector, { chat: async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('temporary model outage');
    return JSON.stringify({ highlight: false, score: 0, title: '', reason: '', durationSeconds: 20 });
  } });
  const startedAt = Date.now() - 15 * 60 * 1000;
  const state = startLiveStream(detector, { startedAt, messages: [
    { at: startedAt + 300_000, username: 'viewer', message: 'Hmm', excitement: 0 }
  ] });

  await detector.checkChannel(state);
  assert.equal(state.live, true);
  assert.equal(state.ending, false);
  assert.equal(state.messages.length, 1);

  await detector.checkChannel(state);
  assert.equal(attempts, 2);
  assert.equal(state.live, false);
  assert.equal(state.messages.length, 0);
});

test('a new stream ID finishes the previous stream before resetting its final chat', async (t) => {
  const HighlightDetector = await loadHighlightDetector(t);
  const requests = [];
  const { detector, scheduled } = makeDetector(HighlightDetector, { chat: async (messages) => {
    requests.push(JSON.parse(messages[1].content));
    return JSON.stringify({ highlight: true, score: 81, title: 'Final play',
      reason: 'Chat reacted to the final play', durationSeconds: 20 });
  } });
  const startedAt = Date.now() - 25 * 60 * 1000;
  const state = startLiveStream(detector, { id: 'vod-before', startedAt, messages: [
    { at: startedAt + 410_000, username: 'viewer-a', message: 'No way', excitement: 1 },
    { at: startedAt + 415_000, username: 'viewer-b', message: 'Clip that', excitement: 6 }
  ] });
  detector.helix = async (pathname) => pathname === '/streams'
    ? [{ id: 'vod-after', started_at: new Date().toISOString(), title: 'New game', game_name: 'Game' }]
    : [];

  await detector.checkChannel(state);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].streamTitle, 'Stream vod-before');
  assert.ok(scheduled.some((snapshot) => snapshot.streamId === 'vod-before'));
  assert.equal(state.streamId, 'vod-after');
  assert.deepEqual(state.messages, []);
});

test('a five-year finalization simulation recovers transient failures and never fabricates empty-chat clips', async (t) => {
  const DAYS = 1826;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const START = Date.parse('2026-10-17T00:00:00.000Z');
  const HighlightDetector = await loadHighlightDetector(t);
  const originalNow = Date.now;
  let simulatedNow = START;
  Date.now = () => simulatedNow;

  const callsByDay = new Map();
  const failuresByDay = new Set();
  const { detector, scheduled } = makeDetector(HighlightDetector, { chat: async (messages) => {
    const request = JSON.parse(messages[1].content);
    const day = Number(request.streamTitle.match(/#(\d+)$/)?.[1]);
    const attempt = (callsByDay.get(day) || 0) + 1;
    callsByDay.set(day, attempt);
    if (day % 37 === 0 && day % 11 !== 0 && attempt === 1) {
      failuresByDay.add(day);
      throw new Error('simulated transient model outage');
    }
    const approved = day % 5 !== 0;
    return JSON.stringify({
      highlight: approved,
      score: approved ? 82 : 0,
      title: approved ? `Observed moment ${day}` : '',
      reason: approved ? 'Model approved the supplied chat evidence' : '',
      durationSeconds: 25
    });
  } });
  detector.helix = async (pathname) => pathname === '/streams' ? [] : [];

  let nonemptyStreams = 0;
  let emptyStreams = 0;
  let recoveredFinalReviews = 0;
  let approvedStreams = 0;
  try {
    for (let day = 1; day <= DAYS; day += 1) {
      const startedAt = START + (day - 1) * DAY_MS;
      const observedOffsetSeconds = 120 + (day % 1800);
      simulatedNow = startedAt + 6 * 60 * 60 * 1000; // delayed offline poll
      const state = detector.stateFor('saevond');
      Object.assign(state, {
        broadcasterId: 'broadcaster-1',
        live: true,
        ending: false,
        checking: false,
        streamId: `vod-${day}`,
        startedAt: new Date(startedAt).toISOString(),
        streamTitle: `Five-year stream #${day}`,
        gameName: 'Simulation'
      });
      state.candidates = [];
      state.followEvents = [];
      state.lastAiAt = 0;
      state.messages = day % 11 === 0 ? [
        { at: startedAt + observedOffsetSeconds * 1000, username: 'viewer', message: '   ', excitement: 0 }
      ] : [
        { at: startedAt + (observedOffsetSeconds - 4) * 1000, username: 'viewer-a', message: 'That was close', excitement: 1 },
        { at: startedAt + observedOffsetSeconds * 1000, username: 'viewer-b', message: 'Nice play', excitement: 1 }
      ];

      const hasEvidence = day % 11 !== 0;
      if (hasEvidence) nonemptyStreams += 1;
      else emptyStreams += 1;
      const shouldRetry = hasEvidence && day % 37 === 0;

      await detector.checkChannel(state);
      if (shouldRetry) {
        assert.equal(state.live, true, `stream ${day} remains active after a failed review`);
        assert.equal(state.ending, false, `stream ${day} can retry after a failed review`);
        assert.ok(state.messages.length > 0, `stream ${day} preserves evidence for retry`);
        await detector.checkChannel(state);
        recoveredFinalReviews += 1;
      }

      assert.equal(state.live, false, `stream ${day} finishes`);
      assert.equal(state.messages.length, 0, `stream ${day} clears evidence only after review`);
      assert.equal(state.pendingFinalize, true, `stream ${day} waits for its VOD`);
      if (!hasEvidence) assert.equal(state.candidates.length, 0, `empty stream ${day} creates no candidate`);

      const snapshot = scheduled.at(-1);
      assert.equal(snapshot.streamId, `vod-${day}`);
      if (snapshot.candidates.length) {
        approvedStreams += 1;
        assert.equal(snapshot.candidates.length, 1);
        assert.equal(snapshot.candidates[0].endSeconds, observedOffsetSeconds + 5,
          `stream ${day} uses the last observed chat timestamp, not the delayed poll`);
        assert.equal(snapshot.candidates[0].startSeconds, observedOffsetSeconds + 5 - 25);
        assert.ok(snapshot.candidates[0].startSeconds >= 0);
      }
    }
  } finally {
    Date.now = originalNow;
  }

  assert.equal(scheduled.length, DAYS, 'one VOD finalization is scheduled per stream');
  assert.equal(new Set(scheduled.map((item) => item.streamId)).size, DAYS, 'no stream is scheduled twice');
  assert.equal(nonemptyStreams, 1660);
  assert.equal(emptyStreams, 166);
  assert.equal(recoveredFinalReviews, 45);
  assert.equal(failuresByDay.size, recoveredFinalReviews);
  assert.equal(approvedStreams, 1328);
  assert.equal(callsByDay.size, nonemptyStreams);
  assert.equal([...callsByDay.values()].reduce((sum, count) => sum + count, 0), nonemptyStreams + recoveredFinalReviews);
});


test('recent low-signal chat survives a deploy and a delayed offline poll', async (t) => {
  const HighlightDetector = await loadHighlightDetector(t);
  const stored = new Map();
  HighlightDetector.testSetRedis({
    async get(key) { return stored.get(key) || null; },
    async set(key, value) { stored.set(key, String(value)); return 'OK'; },
    async del(key) { stored.delete(key); return 1; }
  });

  const startedAt = Date.now() - 10 * 60 * 1000;
  const firstProcess = new HighlightDetector({});
  const liveState = firstProcess.stateFor('saevond');
  Object.assign(liveState, {
    broadcasterId: 'broadcaster-1',
    live: true,
    streamId: 'stream-recovery-test',
    startedAt: new Date(startedAt).toISOString(),
    streamTitle: 'Recovery test',
    gameName: 'Game'
  });

  await firstProcess.observe({
    channel: 'saevond',
    user: { username: 'viewer-a' },
    message: 'That was close'
  });
  const snapshot = JSON.parse(stored.get('highlights:saevond'));
  assert.equal(snapshot.messageHistory.length, 1);
  assert.equal(snapshot.messageHistory[0].message, 'That was close');

  const requests = [];
  const nextProcess = new HighlightDetector({ chat: async (messages) => {
    requests.push(JSON.parse(messages[1].content));
    return JSON.stringify({ highlight: true, score: 82, title: 'Clutch finish',
      reason: 'Chat reacted to the closing play', durationSeconds: 20 });
  } });
  const scheduled = [];
  nextProcess.scheduleFinalize = (state) => scheduled.push(state);
  nextProcess.helix = async (pathname) => pathname === '/streams' ? [] : [];

  const originalNow = Date.now;
  Date.now = () => originalNow() + 75_000;
  try {
    await nextProcess.checkChannel(nextProcess.stateFor('saevond'));
  } finally {
    Date.now = originalNow;
  }

  assert.equal(requests.length, 1, 'the restored final chat is reviewed');
  assert.equal(requests[0].signals.finalWindow, true);
  assert.equal(requests[0].recentChat[0].message, 'That was close');
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].streamId, 'stream-recovery-test');
  assert.equal(scheduled[0].candidates.length, 1);
});

test('Twitch Helix retries transient responses with a bound and fails authorization errors fast', async (t) => {
  const HighlightDetector = await loadHighlightDetector(t);
  const detector = new HighlightDetector({});
  const delays = [];
  detector.helixSleep = async (ms) => delays.push(ms);

  let calls = 0;
  HighlightDetector.testSetAxiosGet(async () => {
    calls += 1;
    if (calls === 1) {
      throw Object.assign(new Error('connection ended during response decompression'), { code: 'ERR_BAD_RESPONSE' });
    }
    return { data: { data: [{ id: 'stream-1' }] } };
  });
  const recovered = await detector.helix('/streams');
  assert.equal(recovered[0].id, 'stream-1');
  assert.equal(calls, 2);
  assert.equal(delays.length, 1);
  assert.ok(delays[0] >= 125 && delays[0] <= 250);

  calls = 0;
  delays.length = 0;
  HighlightDetector.testSetAxiosGet(async () => {
    calls += 1;
    throw Object.assign(new Error('forbidden'), { response: { status: 403 } });
  });
  await assert.rejects(detector.helix('/streams'), /forbidden/);
  assert.equal(calls, 1, 'permission errors are not retried');
  assert.equal(delays.length, 0);
});

test('repeated Twitch 5xx responses stop after the configured attempt limit', async (t) => {
  const HighlightDetector = await loadHighlightDetector(t);
  const detector = new HighlightDetector({});
  let calls = 0;
  detector.helixSleep = async () => {};
  HighlightDetector.testSetAxiosGet(async () => {
    calls += 1;
    throw Object.assign(new Error('temporary service error'), { response: { status: 503 } });
  });

  await assert.rejects(detector.helix('/streams'), /temporary service error/);
  assert.equal(calls, 3);
});
