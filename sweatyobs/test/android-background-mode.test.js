import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../app/src/main/', import.meta.url);
const manifest = readFileSync(new URL('AndroidManifest.xml', root), 'utf8');
const sources = new URL('java/com/saevond/sweatyobs/', root);
function gather(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    const filename = join(path, entry.name);
    return entry.isDirectory() ? gather(filename) : filename.endsWith('.kt') ? [filename] : [];
  });
}
const source = gather(sources.pathname).map(f => readFileSync(f, 'utf8')).join('\n');

test('remote-only Android app requests no media-capture or foreground encoder permissions', () => {
  for (const forbidden of ['RECORD_AUDIO', 'CAMERA', 'FOREGROUND_SERVICE_MEDIA_PROJECTION',
    'CAPTURE_VIDEO_OUTPUT', 'FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_CONNECTED_DEVICE']) {
    assert.equal(manifest.includes('android.permission.' + forbidden), false, forbidden);
  }
  assert.equal(manifest.includes('android:foregroundServiceType="mediaProjection"'), false);
  assert.doesNotMatch(manifest, /android:name="\.Ps5LanService"/);
});

test('Android runtime has no screen capture or recorder code paths', () => {
  for (const forbidden of ['MediaProjectionManager', 'createScreenCaptureIntent', 'ScreenSource(',
    'AudioPlaybackCaptureConfiguration', 'AudioRecord(', 'MediaRecorder(', 'ScreenRecorder(']) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test('visible encoder actions go to the remote API and do not start phone streaming', () => {
  const activity = readFileSync(new URL('java/com/saevond/sweatyobs/MainActivity.kt', root), 'utf8');
  for (const action of ['start', 'stop', 'reconnect', 'play', 'pause', 'skip']) {
    assert.ok(activity.includes(`requestRemoteEncoderAction("${action}")`), action);
  }
  assert.match(activity, /stopService\(Intent\(this, Ps5LanService::class\.java\)\)/);
  assert.match(activity, /RemoteEncoderApi = HttpsRemoteEncoderClient\(\)/);
  assert.match(activity, /legacySecretsCleared = SecretStore\(this\)\.clearAll\(\)/);
  assert.doesNotMatch(activity, /startForegroundService\(/);
  assert.doesNotMatch(activity, /startService\(Intent\(this, Ps5LanService/);
  assert.doesNotMatch(activity, /BrandVideoOverlay|BrandOverlayCanvas|brand_overlay|overlay_quality/);
});
