import test from 'node:test';
import assert from 'node:assert/strict';
import { createEncoderEventBridge } from '../src/music/encoderBridge.js';

const token = 's'.repeat(48);
const state = { station: 'dubstep', playing: false };

test('bridge rejects unauthenticated polling and disables without configured secret', () => {
  const disabled = createEncoderEventBridge({ getState: () => state });
  assert.equal(disabled.poll('Bearer ' + token).status, 404);
  const bridge = createEncoderEventBridge({ token, getState: () => state });
  assert.equal(bridge.poll('Bearer invalid').status, 401);
  assert.equal(bridge.poll('Bearer ' + token).status, 200);
});

test('ordered music events, no duplicate replay, and resync after overflow', () => {
  const bridge = createEncoderEventBridge({ token, getState: () => state, historyLimit: 16 });
  const begin = bridge.poll('Bearer ' + token).body;
  for (const action of ['play', 'skip', 'pause']) bridge.publish({ type: 'music.control', action, state });
  const next = bridge.poll('Bearer ' + token, begin.cursor).body;
  assert.deepEqual(next.events.map(x => x.action), ['play', 'skip', 'pause']);
  assert.deepEqual(bridge.poll('Bearer ' + token, next.cursor).body.events, []);
  for (let i = 0; i < 20; i++) bridge.publish({ type: 'music.control', action: 'skip', state });
  assert.equal(bridge.poll('Bearer ' + token, begin.cursor).body.reset, true);
});

test('restart resync publishes full current state, not stale skip events', () => {
  const bridge = createEncoderEventBridge({ token, getState: () => ({
    station: 'club', playing: false, volumePercent: 22,
  }) });
  bridge.publish({ type: 'music.control', action: 'skip', state: { station: 'club', volumePercent: 22 } });
  const resync = bridge.poll('Bearer ' + token, 'old-instance:0').body;
  assert.equal(resync.reset, true);
  assert.equal(resync.state.station, 'club');
  assert.equal(resync.state.playing, false);
  assert.equal(resync.state.volumePercent, 22);
  assert.deepEqual(resync.events, []);
});

test('fails closed on malformed event types and cursor', () => {
  const bridge = createEncoderEventBridge({ token, getState: () => state });
  const begin = bridge.poll('Bearer ' + token).body;
  bridge.publish({ type: 'music.player.status', action: 'play', state });
  bridge.publish({ type: 'music.control', action: 'run', state });
  assert.equal(bridge.poll('Bearer ' + token, begin.cursor).body.events.length, 0);
  assert.equal(bridge.poll('Bearer ' + token, begin.cursor + 'tampered').body.reset, true);
});

test('remote volume event preserves game audio and validates range', () => {
  const bridge = createEncoderEventBridge({ token, getState: () => ({
    station: 'dubstep', playing: true, volumePercent: 22,
  }) });
  const first = bridge.poll('Bearer ' + token).body;
  bridge.publish({ type: 'music.control', action: 'volume', state: {
    station: 'dubstep', playing: true, volumePercent: 35,
  } });
  const result = bridge.poll('Bearer ' + token, first.cursor).body;
  assert.equal(result.events.length, 1);
  assert.deepEqual([result.events[0].action, result.events[0].volumePercent], ['volume', 35]);
  bridge.publish({ type: 'music.control', action: 'volume', state: {
    station: 'dubstep', playing: true, volumePercent: 101,
  } });
  assert.deepEqual(bridge.poll('Bearer ' + token, result.cursor).body.events, []);
});
