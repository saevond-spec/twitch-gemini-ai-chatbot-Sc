import test from 'node:test';
import assert from 'node:assert/strict';
import { finalWindowOffsetSeconds, finalWindowSignals } from '../highlight-window.js';

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
