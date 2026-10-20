import test from 'node:test';
import assert from 'node:assert/strict';
import { createEncoderEventBridge } from '../src/music/encoderBridge.js';
import { applyPacket } from '../encoder/bridge-client.mjs';

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

test('restart resync restores selected station, paused state and skips stale events', () => {
  const calls = [];
  const feeder = { command: (...args) => calls.push(args) };
  applyPacket(feeder, { reset: true, state: { station: 'club', playing: false }, events: [{ action: 'skip' }] });
  assert.deepEqual(calls, [['station', 'club'], ['pause']]);
});

test('fails closed on malformed event types and cursor', () => {
  const bridge = createEncoderEventBridge({ token, getState: () => state });
  const begin = bridge.poll('Bearer ' + token).body;
  bridge.publish({ type: 'music.player.status', action: 'play', state });
  bridge.publish({ type: 'music.control', action: 'run', state });
  assert.equal(bridge.poll('Bearer ' + token, begin.cursor).body.events.length, 0);
  assert.equal(bridge.poll('Bearer ' + token, begin.cursor + 'tampered').body.reset, true);
});
