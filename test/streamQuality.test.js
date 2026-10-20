import test from 'node:test';
import assert from 'node:assert/strict';
import { STREAM_TARGETS, assessPs5Input, estimateNativeFanout } from '../server/streamQuality.mjs';
test('1080p60 is a native pass-through target, not fake upscale', () => {
  assert.equal(STREAM_TARGETS.fullHd60.width, 1920);
  assert.equal(STREAM_TARGETS.fullHd60.height, 1080);
  assert.equal(STREAM_TARGETS.fullHd60.fps, 60);
  assert.equal(assessPs5Input({ codec: 'h264', width: 1920, height: 1080, fps: 60, bitrateKbps: 6000 }).supported, true);
  assert.equal(assessPs5Input({ codec: 'h264', width: 1280, height: 720, fps: 60, bitrateKbps: 4000 }).supported, false);
  assert.equal(assessPs5Input({ codec: 'h265', width: 1920, height: 1080, fps: 60, bitrateKbps: 6000 }).supported, false);
});
test('triple 1080p60 fanout budgets upload and has no application session-length cap', () => {
  const plan = estimateNativeFanout({ destinations: 3 });
  assert.equal(plan.outgoingMbps, 18.48);
  assert.ok(plan.recommendedStableUploadMbps > 26.3);
  assert.equal(plan.sessionCapHours, null);
});
test('Kick interoperability rejects video above 8000 kbps', () => {
  assert.equal(assessPs5Input({ codec: 'h264', width: 1920, height: 1080, fps: 60, bitrateKbps: 12000 }).supported, false);
});
