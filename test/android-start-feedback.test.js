import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root = new URL('../android-obs/app/src/main/', import.meta.url);
const ui = readFileSync(new URL('java/com/saevond/sweatyobs/MainActivity.kt', root), 'utf8');
const service = readFileSync(new URL('java/com/saevond/sweatyobs/Ps5LanService.kt', root), 'utf8');
test('Start click always updates visible UI before service launch', () => {
  const start = ui.indexOf('startLan.setOnClickListener');
  const feedback = ui.indexOf('status.text = "Checking the diagnostic-only PS5 ingest', start);
  const launch = ui.indexOf('startForegroundService(', start);
  assert.ok(start >= 0 && feedback > start && launch > feedback);
});
test('service stores failure statuses and sends an app-only broadcast', () => {
  assert.match(service, /getSharedPreferences\(STATUS_PREFS/);
  assert.match(service, /sendBroadcast\(Intent\(ACTION_STATUS/);
  assert.match(service, /setPackage\(packageName\)/);
  assert.match(ui, /registerReceiver\(statusReceiver/);
  assert.match(ui, /getSharedPreferences\(Ps5LanService.STATUS_PREFS/);
});
test('emulator smoke test must be present in Android workflow', () => {
  const workflow = readFileSync(new URL('../.github/workflows/android-obs.yml', import.meta.url),'utf8');
  assert.match(workflow, /android-emulator-runner@v2/);
  assert.match(workflow, /connectedDebugAndroidTest/);
});
