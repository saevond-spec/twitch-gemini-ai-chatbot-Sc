import test from 'node:test';
import assert from 'node:assert/strict';
import { finalWindowOffsetSeconds, finalWindowSignals } from '../highlight-window.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';


test('final review summarizes remaining chat without requiring a trigger spike', () => {
  const signals = finalWindowSignals([
    { username: 'viewer-a', message: 'That was close', excitement: 1 },
    { username: 'viewer-b', message: 'clip that', excitement: 6 },
    { username: 'viewer-a', message: 'wow', excitement: 2 }
  ], [Date.now()]);
  assert.deepEqual(signals, {
    finalWindow: true,
    explicitClip: true,
    uniqueUsers: 2,
    totalExcitement: 9,
    followCount: 1
  });
});

test('final review skips empty chat instead of fabricating evidence', () => {
  assert.equal(finalWindowSignals([], []), null);
  assert.equal(finalWindowSignals([{ username: 'viewer', message: '   ' }], []), null);
});

test('final clip timestamp uses the latest observed message, not the delayed offline poll', () => {
  const start = Date.parse('2026-10-17T10:00:00.000Z');
  const messages = [
    { at: start + 119_000 },
    { at: start + 121_000 }
  ];
  assert.equal(finalWindowOffsetSeconds('2026-10-17T10:00:00.000Z', messages, start + 180_000), 121);
});

async function loadHighlightDetector(t) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'highlight-detector-test-'));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const detector = await fs.readFile(path.join(sourceRoot, 'highlight-detector.js'), 'utf8');
  const helper = await fs.readFile(path.join(sourceRoot, 'highlight-window.js'), 'utf8');
  const files = {
    'package.json': JSON.stringify({ type: 'module' }),
    'node_modules/axios/package.json': JSON.stringify({ type: 'module', exports: './index.js' }),
    'node_modules/axios/index.js': "export default { post: async () => ({ status: 200 }) };",
    'src/config/index.js': "export const config = { twitch: { channels: ['saevond'] } };",
    'src/twitch/auth.js': "export async function getAccessToken() { return 'test-token'; }",
    'src/storage/redis.js': "export function getRedis() { return null; }",
    'src/logger/index.js': "export function createLogger() { return { info() {}, warn() {}, error() {} }; }",
    'src/bus/index.js': "const bus = { on() {}, off() {} }; export default bus;",
    'src/highlights/detector.js': detector,
    'src/highlights/final-window.js': helper
  };
  await Promise.all(Object.entries(files).map(async ([relative, contents]) => {
    const filePath = path.join(tempRoot, relative);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents);
  }));
  const moduleUrl = pathToFileURL(path.join(tempRoot, 'src/highlights/detector.js')).href;
  return (await import(moduleUrl + '?test=' + Math.random())).HighlightDetector;
}

function enableHighlightDetector(t) {
  const names = ['HIGHLIGHT_DETECTION_ENABLED', 'CLIP_WEBHOOK_URL', 'CLIP_WEBHOOK_KEY'];
  const before = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.HIGHLIGHT_DETECTION_ENABLED = 'true';
  process.env.CLIP_WEBHOOK_URL = 'https://example.invalid/clip';
  process.env.CLIP_WEBHOOK_KEY = 'test-key';
  t.after(() => names.forEach((name) => {
    if (before[name] === undefined) delete process.env[name];
    else process.env[name] = before[name];
  }));
}

test('offline finalization reviews a quiet final window and schedules its correctly timed candidate', async (t) => {
  enableHighlightDetector(t);
  const HighlightDetector = await loadHighlightDetector(t);
  const requests = [];
  const snapshots = [];
  const detector = new HighlightDetector({ chat: async (messages) => {
    requests.push(JSON.parse(messages[1].content));
    return JSON.stringify({ highlight: true, score: 80, title: 'Clutch finish',
      reason: 'Two viewers reacted to the final play', durationSeconds: 20 });
  } });
  detector.persist = async () => {};
  detector.scheduleFinalize = (snapshot) => snapshots.push(snapshot);
  const start = Date.parse('2026-10-17T10:00:00.000Z');
  const state = detector.stateFor('saevond');
  Object.assign(state, { live: true, streamId: 'vod-1',
    startedAt: '2026-10-17T10:00:00.000Z', streamTitle: 'Game', gameName: 'Game' });
  state.messages = [
    { at: start + 119000, username: 'viewer-a', message: 'that was close', excitement: 1 },
    { at: start + 121000, username: 'viewer-b', message: 'nice', excitement: 1 }
  ];

  await detector.finishStream(state);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].signals.finalWindow, true);
  assert.equal(requests[0].streamOffsetSeconds, 121);
  assert.equal(state.live, false);
  assert.equal(state.messages.length, 0);
  assert.equal(state.pendingFinalize, true);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].candidates[0].endSeconds, 126);
});

test('failed final review preserves the chat evidence for a later offline retry', async (t) => {
  enableHighlightDetector(t);
  const HighlightDetector = await loadHighlightDetector(t);
  let attempts = 0;
  const detector = new HighlightDetector({ chat: async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('temporary model outage');
    return JSON.stringify({ highlight: false, score: 0, title: '', reason: '', durationSeconds: 20 });
  } });
  detector.persist = async () => {};
  detector.scheduleFinalize = () => {};
  const state = detector.stateFor('saevond');
  Object.assign(state, { live: true, streamId: 'vod-2',
    startedAt: '2026-10-17T10:00:00.000Z', streamTitle: 'Game', gameName: 'Game' });
  state.messages = [{ at: Date.now(), username: 'viewer-a', message: 'hmm', excitement: 0 }];

  await assert.rejects(detector.finishStream(state), /temporary model outage/);
  assert.equal(state.live, true);
  assert.equal(state.ending, false);
  assert.equal(state.messages.length, 1);
  await detector.finishStream(state);

  assert.equal(attempts, 2);
  assert.equal(state.live, false);
});
