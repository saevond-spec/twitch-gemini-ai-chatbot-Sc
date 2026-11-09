import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaProgress } from '../server/media-progress.mjs';
import { ReceiverControl } from '../src/encoder/receiverControl.js';

test('video processing advances from FFmpeg progress without claiming audio or viewer playback', () => {
  let now = Date.parse('2026-11-09T12:00:00Z');
  const p = new MediaProgress({ now: () => now });
  assert.equal(p.snapshot().sourceState, 'WAITING_FOR_MEDIA');
  for (const line of ['frame=1701', 'total_size=12345678', 'out_time_us=56400000', 'speed=1.02x', 'progress=continue']) p.accept(line);
  assert.deepEqual({
    frames: p.snapshot().videoFrames, bytes: p.snapshot().outputBytes, milliseconds: p.snapshot().outputTimeMs
  }, { frames: 1701, bytes: 12345678, milliseconds: 56400 });
  assert.equal(p.snapshot().audioPackets, null);
  assert.equal(p.snapshot().downstreamPlaybackVerified, false);
  assert.equal(p.snapshot().sourceState, 'PROCESSING');
  now += 21000;
  assert.equal(p.snapshot().sourceState, 'STALLED');
  p.accept('frame=1702');
  assert.equal(p.snapshot().sourceState, 'PROCESSING');
});

test('media parser rejects corrupt and declining counters', () => {
  const p = new MediaProgress();
  for (const line of ['frame=-1', 'frame=NaN', 'frame=Infinity', 'frame=1e12', 'speed=unsafe', 'total_size=-3']) p.accept(line);
  assert.equal(p.snapshot().videoFrames, 0);
  assert.equal(p.snapshot().outputBytes, 0);
  assert.equal(p.snapshot().speed, null);
  p.accept('frame=6'); p.accept('frame=2');
  assert.equal(p.snapshot().videoFrames, 6);
});

test('receiver accepts a valid real-time frame report but labels downstream unverified', () => {
  const c = new ReceiverControl();
  const media = new MediaProgress();
  media.accept('frame=20');
  const result = c.poll({ id: 'receiver001', state: 'DIAGNOSTIC', frames: 20, revision: 1,
    media: media.snapshot(), ack: null });
  assert.equal(result.leaseSeconds, 30);
  assert.equal(c.snapshot().media.videoFrames, 20);
  assert.match(c.snapshot().reason, /playback is not verified/);
  assert.throws(() => c.poll({ id: 'receiver001', state: 'DIAGNOSTIC', frames: 21, revision: 1,
    media: media.snapshot() }), /Invalid receiver media progress/);
});

test('stalled stream state allows manual reconnect, not automatically broadcasting', () => {
  const c = new ReceiverControl();
  const media = new MediaProgress();
  media.accept('frame=12');
  c.poll({ id: 'receiver001', state: 'STALLED', frames: 12, revision: 1, media: media.snapshot() });
  assert.match(c.snapshot().reason, /stopped increasing/);
  const snapshot = c.command('reconnect', { streamKey: 'a-secret' });
  assert.equal(snapshot.pending.action, 'reconnect');
  assert.equal(snapshot.state, 'STALLED');
});

test('no video or audio can be inferred from control heartbeat alone', () => {
  const c = new ReceiverControl();
  c.poll({ id: 'receiver001', state: 'STARTING', frames: 0, revision: 0 });
  assert.equal(c.snapshot().frames, 0);
  assert.equal(c.snapshot().media, null);
  assert.match(c.snapshot().reason, /awaiting PS5 media/);
});
