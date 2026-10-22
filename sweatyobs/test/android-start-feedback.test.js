import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root = new URL('../app/src/main/', import.meta.url);
const ui = readFileSync(new URL('java/com/saevond/sweatyobs/MainActivity.kt', root), 'utf8');
const service = readFileSync(new URL('java/com/saevond/sweatyobs/Ps5LanService.kt', root), 'utf8');
test('remote start, reconnect, and stop buttons only send HTTPS control requests', () => {
  assert.match(ui, /id = R\.id\.start_remote_encoder[\s\S]{0,500}requestRemoteEncoderAction\("start"\)/);
  assert.match(ui, /id = R\.id\.reconnect_remote_encoder[\s\S]{0,300}requestRemoteEncoderAction\("reconnect"\)/);
  assert.match(ui, /id = R\.id\.stop_remote_encoder[\s\S]{0,250}requestRemoteEncoderAction\("stop"\)/);
  assert.doesNotMatch(ui, /startForegroundService\(/);
  assert.doesNotMatch(ui, /startService\(Intent\(this, Ps5LanService/);
});
test('remote-only migration removes old phone credentials and destination URLs', () => {
  assert.match(ui, /SecretStore\(this\)\.clearAll\(\)/);
  assert.match(ui, /clearPreferences\("encoder_outputs"\)/);
  assert.match(ui, /"ps5_setup", "ps5_music", "ps5_audio_levels"/);
  assert.match(ui, /\.map\(::clearPreferences\)\.all\s*\{\s*it\s*\}/);
  assert.match(ui, /legacyPreferencesCleared/);
  assert.match(ui, /clearPersistedMusicPermissions\(\)/);
  assert.doesNotMatch(ui, /putString\("youtube_server",\s*RtmpsPublisher/);
  assert.doesNotMatch(ui, /putString\("kick_server",\s*RtmpsPublisher/);
});
test('emulator smoke test must be present in Android workflow', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/sweatyobs-android.yml', import.meta.url),'utf8');
  assert.match(workflow, /android-emulator-runner@v2/);
  assert.match(workflow, /connectedDebugAndroidTest/);
});
