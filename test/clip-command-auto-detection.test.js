import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.HIGHLIGHT_DETECTION_ENABLED = 'true';

async function loadDetector(t) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'clip-command-test-'));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  const detector = await fs.readFile(path.join(sourceRoot, 'src/highlights/detector.js'), 'utf8');
  const scoring = await fs.readFile(path.join(sourceRoot, 'src/highlights/scoring.js'), 'utf8');
  const helper = await fs.readFile(path.join(sourceRoot, 'highlight-window.js'), 'utf8');

  const files = {
    'package.json': JSON.stringify({ type: 'module' }),
    'node_modules/axios/package.json': JSON.stringify({ type: 'module', exports: './index.js' }),
    'node_modules/axios/index.js': "export default { get: async () => ({ data: { data: [] } }) };",
    'src/config/index.js': "export const config = { twitch: { channels: ['saevond'], clientId: 'test-client' } };",
    'src/twitch/auth.js': "export function getAccessToken() { return 'test-token'; }",
    'src/storage/redis.js': "export function getRedis() { return null; }",
    'src/logger/index.js': "export function createLogger() { return { info() {}, warn() {}, error() {} }; }",
    'src/bus/index.js': "const bus = { on() {}, off() {} }; export default bus;",
    'src/clips/twitchClipService.js': `
      export const calls = [];
      export async function createClipFromVod(args) {
        calls.push(args);
        return { id: 'clip-' + calls.length, url: 'https://clips.twitch.tv/clip-' + calls.length };
      }
    `,
    'src/queue/index.js': `
      export const jobs = [];
      export async function enqueueTask(name, data, opts) { jobs.push({ name, data, opts }); return { id: opts?.jobId || 'job' }; }
    `,
    'src/highlights/scoring.js': scoring,
    'src/highlights/detector.js': detector,
    'highlight-window.js': helper,
  };

  await Promise.all(Object.entries(files).map(async ([relative, contents]) => {
    const filePath = path.join(tempRoot, relative);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents);
  }));

  const loaded = await import(pathToFileURL(path.join(tempRoot, 'src/highlights/detector.js')).href + '?t=' + Math.random());
  const clipModule = await import(pathToFileURL(path.join(tempRoot, 'src/clips/twitchClipService.js')).href);
  const queueModule = await import(pathToFileURL(path.join(tempRoot, 'src/queue/index.js')).href);
  return { HighlightDetector: loaded.HighlightDetector, clipModule, queueModule };
}

function primeLive(detector, now = Date.parse('2026-10-17T18:00:00.000Z')) {
  detector.restore = async () => {};
  detector.persist = async () => {};
  detector.helixSleep = async () => {};
  detector.helix = async pathname => pathname === '/videos'
    ? [{ id: 'vod-live', stream_id: 'stream-live', created_at: new Date(now - 10 * 60_000).toISOString(), duration: '10m0s' }]
    : [];
  const state = detector.stateFor('saevond');
  Object.assign(state, {
    live: true,
    ending: false,
    broadcasterId: 'broadcaster-1',
    streamId: 'stream-live',
    startedAt: new Date(now - 10 * 60_000).toISOString(),
    gameName: 'NARAKA: BLADEPOINT',
    streamTitle: 'Ranked',
    candidates: [],
    messages: [],
    messageHistory: [],
    followEvents: [],
    clipVotes: [],
    lastManualClipAt: 0,
  });
  return { state, now };
}

test('broadcaster !clip immediately creates an official Twitch clip', async (t) => {
  const { HighlightDetector, clipModule, queueModule } = await loadDetector(t);
  const detector = new HighlightDetector({ chat: async () => '{}' });
  const { now } = primeLive(detector);

  const result = await detector.requestManualClip({
    channel: '#saevond',
    user: { username: 'saevond', badges: { broadcaster: '1' } },
    message: '!clip insane parry',
    now,
  });

  assert.equal(result.status, 'created');
  assert.match(result.url, /clips\.twitch\.tv/);
  assert.equal(clipModule.calls.length, 1);
  assert.equal(clipModule.calls[0].title, 'insane parry');
  assert.equal(clipModule.calls[0].durationSeconds, 35);
  assert.equal(queueModule.jobs.length, 1);
  assert.equal(queueModule.jobs[0].name, 'generate-clips');
});

test('regular viewers require two unique !clip votes', async (t) => {
  const { HighlightDetector, clipModule } = await loadDetector(t);
  const detector = new HighlightDetector({ chat: async () => '{}' });
  const { now } = primeLive(detector);

  const one = await detector.requestManualClip({
    channel: '#saevond',
    user: { username: 'viewer1', badges: {} },
    message: '!clip',
    now,
  });
  assert.equal(one.status, 'vote');
  assert.equal(one.votes, 1);
  assert.equal(clipModule.calls.length, 0);

  const duplicate = await detector.requestManualClip({
    channel: '#saevond',
    user: { username: 'viewer1', badges: {} },
    message: '!clip',
    now: now + 1000,
  });
  assert.equal(duplicate.status, 'vote');
  assert.equal(duplicate.votes, 1);
  assert.equal(clipModule.calls.length, 0);

  const two = await detector.requestManualClip({
    channel: '#saevond',
    user: { username: 'viewer2', badges: {} },
    message: '!clip viewer title should not be trusted',
    now: now + 2000,
  });
  assert.equal(two.status, 'created');
  assert.equal(clipModule.calls.length, 1);
  assert.equal(clipModule.calls[0].title, 'NARAKA: BLADEPOINT live highlight');
});

test('manual clip cooldown prevents duplicate clips', async (t) => {
  const { HighlightDetector, clipModule } = await loadDetector(t);
  const detector = new HighlightDetector({ chat: async () => '{}' });
  const { now } = primeLive(detector);

  const user = { username: 'saevond', badges: { broadcaster: '1' } };
  assert.equal((await detector.requestManualClip({ channel: '#saevond', user, message: '!clip', now })).status, 'created');
  const second = await detector.requestManualClip({ channel: '#saevond', user, message: '!clip', now: now + 5000 });
  assert.equal(second.status, 'cooldown');
  assert.equal(clipModule.calls.length, 1);
});

test('!clip command is recorded but never races automatic AI evaluation', async (t) => {
  const { HighlightDetector } = await loadDetector(t);
  let aiCalls = 0;
  const detector = new HighlightDetector({ chat: async () => { aiCalls += 1; return '{}'; } });
  const { state } = primeLive(detector);

  await detector.observe({
    channel: '#saevond',
    user: { username: 'viewer1' },
    message: '!clip',
  });

  assert.equal(aiCalls, 0);
  assert.equal(state.messageHistory.length, 1);
});

test('very strong multi-viewer spike still creates a candidate when AI is unavailable', async (t) => {
  const { HighlightDetector } = await loadDetector(t);
  const detector = new HighlightDetector({ chat: async () => { throw new Error('provider unavailable'); } });
  const { state } = primeLive(detector);

  await detector.observe({ channel: '#saevond', user: { username: 'alice' }, message: 'NO WAY insane clutch' });
  await detector.observe({ channel: '#saevond', user: { username: 'bob' }, message: 'HOLY that was crazy' });
  await detector.observe({ channel: '#saevond', user: { username: 'charlie' }, message: 'WOW GOATED' });

  assert.equal(state.candidates.length, 1);
  assert.ok(state.candidates[0].score >= 84);
  assert.match(state.candidates[0].reason, /High-confidence audience anomaly/);
});

test('offline !clip gives a clear response and creates nothing', async (t) => {
  const { HighlightDetector, clipModule } = await loadDetector(t);
  const detector = new HighlightDetector({ chat: async () => '{}' });
  detector.restore = async () => {};
  const result = await detector.requestManualClip({
    channel: '#saevond',
    user: { username: 'saevond', badges: { broadcaster: '1' } },
    message: '!clip',
  });
  assert.equal(result.status, 'offline');
  assert.equal(clipModule.calls.length, 0);
});
