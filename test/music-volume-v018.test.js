import test from 'node:test';
import assert from 'node:assert/strict';
import { createMusicController } from '../src/music/player.js';
import { createEncoderEventBridge } from '../src/music/encoderBridge.js';
const owner = { badges: { broadcaster: '1' } };
const mod = { mod: true };
const guest = { mod: false, badges: {} };

test('v0.1.8 !volume starts at 22%, reports current value, and restricts writes to moderator or owner', () => {
  const sent = [];
  const c = createMusicController({ publisher: event => sent.push(event) });
  assert.match(c.handleVolumeCommand(guest, '!volume'), /22%/);
  assert.match(c.handleVolumeCommand(guest, '!volume 55'), /Only the broadcaster or a moderator/);
  assert.equal(sent.length, 0);
  assert.match(c.handleVolumeCommand(owner, '!volume 0'), /0%/);
  assert.match(c.handleVolumeCommand(mod, '!volume 100'), /100%/);
  assert.equal(c.getState().volumePercent, 100);
  assert.equal(sent.map(x => x.action).join(','), 'volume,volume');
});

test('v0.1.8 !volume rejects out-of-range and malformed inputs without publishing', () => {
  const sent = [];
  const c = createMusicController({ publisher: event => sent.push(event) });
  for (const cmd of ['!volume -1','!volume 101','!volume 22.5','!volume 0x16','!volume 15 extra','!volume nan']) {
    assert.match(c.handleVolumeCommand(owner, cmd), /Usage/);
  }
  assert.equal(c.getState().volumePercent, 22);
  assert.equal(sent.length, 0);
});

test('v0.1.8 authenticated music bridge emits ordered bounded volume changes and full-state resync', () => {
  const token = 'm'.repeat(48);
  const c = createMusicController();
  const bridge = createEncoderEventBridge({ token, getState: c.getState });
  c.setPublisher(bridge.publish);
  assert.equal(bridge.poll('Bearer wrong').status, 401);
  const initial = bridge.poll('Bearer '+ token).body;
  assert.equal(initial.reset, true);
  assert.equal(initial.state.volumePercent,22);
  c.handleVolumeCommand(owner,'!volume 67');
  const next = bridge.poll('Bearer '+ token, initial.cursor).body;
  assert.equal(next.events.length,1);
  assert.deepEqual({ action: next.events[0].action, volume: next.events[0].volumePercent }, {action:'volume',volume:67});
  assert.equal(bridge.poll('Bearer '+token,next.cursor).body.events.length,0);
  assert.equal(bridge.poll('Bearer '+token,'wrong:999').body.state.volumePercent,67);
});

test('legacy music events without volume still reach the encoder with safe default', () => {
  const state = { station:'dubstep',playing:true };
  const token='l'.repeat(48);
  const bridge = createEncoderEventBridge({ token, getState:()=>state });
  const cursor = bridge.poll('Bearer '+token).body.cursor;
  bridge.publish({type:'music.control',action:'skip',state});
  const result = bridge.poll('Bearer '+token,cursor).body.events;
  assert.equal(result.length,1);
  assert.equal(result[0].volumePercent,22);
});
