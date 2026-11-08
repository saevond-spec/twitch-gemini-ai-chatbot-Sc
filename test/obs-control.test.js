import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { ObsWebControl, validateRelay, createObsWebRouter, probeRelay } from '../src/encoder/obsWebControl.js';

const settings = { relayUrl: 'rtmps://ingest.sleipnir.tv:1936/live', streamKey: 'test-private-key', receiverAddress: '192.168.1.108' };
test('encrypted settings survive restart without exposing the key in status or disk', t => {
  const dir = mkdtempSync(join(tmpdir(), 'obs-settings-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { OBS_CONTROL_SETTINGS_FILE: join(dir, 'settings'), OBS_CONTROL_ENCRYPTION_KEY: 'a'.repeat(64) };
  const control = new ObsWebControl({ env });
  control.save(settings);
  assert.ok(!readFileSync(env.OBS_CONTROL_SETTINGS_FILE, 'utf8').includes(settings.streamKey));
  assert.ok(!JSON.stringify(control.snapshot()).includes(settings.streamKey));
  const restored = new ObsWebControl({ env });
  assert.equal(restored.settings.streamKey, settings.streamKey);
  restored.save({ ...settings, streamKey: '' });
  assert.equal(restored.settings.streamKey, settings.streamKey);
  restored.save({ ...settings, streamKey: '', clearKey: true });
  assert.equal(restored.snapshot().settings.keyConfigured, false);
  const wrong = new ObsWebControl({ env: { ...env, OBS_CONTROL_ENCRYPTION_KEY: 'b'.repeat(64) } });
  assert.equal(wrong.snapshot().settings.storageError, true);
  assert.throws(() => wrong.save(settings), /could not be decrypted/);
});
test('unconfigured storage is explicit and cannot claim receiver application', () => {
  const control = new ObsWebControl({ env: {} });
  const state = control.save(settings);
  assert.equal(state.settings.storage, 'session_only');
  assert.equal(state.settings.appliedToReceiver, false);
  assert.equal(state.receiver.controllable, false);
});
test('rejects arbitrary probe hosts, unsafe keys, paths and invalid receiver addresses', () => {
  for (const relayUrl of ['rtmp://ingest.sleipnir.tv/live', 'rtmps://localhost/live',
    'rtmps://ingest.sleipnir.tv.evil.test/live', 'rtmps://ingest.sleipnir.tv:22/live',
    'rtmps://ingest.sleipnir.tv/live/secret', 'rtmps://ingest.sleipnir.tv/live?key=x']) {
    assert.throws(() => validateRelay({ ...settings, relayUrl }));
  }
  assert.throws(() => validateRelay({ ...settings, receiverAddress: '192.168.1.108:1935' }));
  assert.throws(() => validateRelay({ ...settings, streamKey: 'key\nfoo' }));
});
test('authenticated reports expire and events do not revive old media counts', () => {
  let now = 1000;
  const control = new ObsWebControl({ env: {}, now: () => now });
  control.observe({ kind: 'encoder_connection_sample', sessionId: 'fixture',
    ingest: { videoPackets: 100, audioPackets: 50 }, destinations: [{ id: 'sleipnir', bytesPerSecond: 1000, state: 'LIVE' }] });
  assert.equal(control.snapshot().telemetry.fresh, true);
  now += 90001;
  control.observe({ kind: 'encoder_app_event', result: 'live' });
  assert.equal(control.snapshot().telemetry.fresh, false);
  assert.equal(control.snapshot().telemetry.sample, null);
});
test('TLS probe verifies certificate and does not send a stream key', async () => {
  let opts;
  const result = await probeRelay(settings.relayUrl, (options, callback) => {
    opts = options; queueMicrotask(callback);
    return { on() {}, destroy() {} };
  });
  assert.equal(opts.port, 1936);
  assert.equal(opts.rejectUnauthorized, true);
  assert.equal(result.reachable, true);
  assert.ok(!JSON.stringify(opts).includes(settings.streamKey));
});
test('settings and checks require authentication, prevent caching, and throttle probes', async t => {
  const app = express();
  const control = new ObsWebControl({ env: {}, probe: async () => ({ reachable: true }) });
  app.use(express.json());
  app.use('/api/obs-web', createObsWebRouter({ control, requireAdmin: (req, res, next) => {
    if (req.get('authorization') !== 'Bearer fixture') return res.sendStatus(401);
    next();
  } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  const root = `http://127.0.0.1:${server.address().port}/api/obs-web/`;
  assert.equal((await fetch(root + 'status')).status, 401);
  const headers = { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' };
  const saved = await fetch(root + 'settings', { method: 'PUT', headers, body: JSON.stringify(settings) });
  assert.equal(saved.status, 200);
  assert.equal(saved.headers.get('cache-control'), 'no-store');
  assert.ok(!(await saved.text()).includes(settings.streamKey));
  assert.equal((await fetch(root + 'check', { method: 'POST', headers })).status, 200);
  assert.equal((await fetch(root + 'check', { method: 'POST', headers })).status, 429);
});
