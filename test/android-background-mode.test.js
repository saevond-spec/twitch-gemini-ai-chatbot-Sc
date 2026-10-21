import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../android-obs/app/src/main/', import.meta.url);
const manifest = readFileSync(new URL('AndroidManifest.xml', root), 'utf8');
const sources = new URL('java/com/saevond/sweatyobs/', root);
function gather(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    const filename = join(path, entry.name);
    return entry.isDirectory() ? gather(filename) : filename.endsWith('.kt') ? [filename] : [];
  });
}
const source = gather(sources.pathname).map(f => readFileSync(f, 'utf8')).join('\n');

test('Android app never requests any screen, microphone, or camera capture permissions', () => {
  for (const forbidden of ['RECORD_AUDIO', 'CAMERA', 'FOREGROUND_SERVICE_MEDIA_PROJECTION', 'CAPTURE_VIDEO_OUTPUT']) {
    assert.equal(manifest.includes('android.permission.' + forbidden), false, forbidden);
  }
  assert.equal(manifest.includes('android:foregroundServiceType="mediaProjection"'), false);
  assert.match(manifest, /android:foregroundServiceType="connectedDevice"/);
});

test('Android runtime has no screen capture or recorder code paths', () => {
  for (const forbidden of ['MediaProjectionManager', 'createScreenCaptureIntent', 'ScreenSource(',
    'AudioPlaybackCaptureConfiguration', 'AudioRecord(', 'MediaRecorder(', 'ScreenRecorder(']) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test('Multistream UI exposes reconnect, the simulated HUD, and honest video limits', () => {
  assert.match(source, /GO LIVE TO SELECTED PLATFORMS/);
  assert.match(source, /destination reconnects independently/);
  assert.match(source, /ACTION_RECONNECT_OUTPUTS/);
  assert.match(source, /Viewer playback is unverified/);
  assert.match(source, /Stats, chat, and alerts are simulated/);
  assert.match(source, /not 4K/);
  assert.match(source, /Stable multi-stream/);
  assert.match(source, /brand_overlay/);
  assert.match(source, /RtmpDestination\("youtube"/);
  assert.match(source, /RtmpDestination\("kick"/);
});
