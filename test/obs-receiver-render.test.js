import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { receiverArgs } from '../server/web-receiver-agent.mjs';
const ffmpeg = process.env.OBS_TEST_FFMPEG || 'ffmpeg';
const available = spawnSync(ffmpeg, ['-version']).status === 0;
test('receiver profile renders real video with rotation, upright branding and audio', { skip: !available }, t => {
  const dir = mkdtempSync(join(tmpdir(), 'receiver-render-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'source.mp4'), target = join(dir, 'output.flv');
  const fixture = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1', '-c:v', 'libx264', '-c:a', 'aac', source], { encoding: 'utf8' });
  assert.equal(fixture.status, 0, fixture.stderr);
  const args = receiverArgs('start', { relayUrl: 'rtmps://ingest.sleipnir.tv/live', streamKey: 'offline-fixture',
    profile: { quality: '540p30', overlay: true, rotate180: true, gameVolume: 35 } });
  args[args.indexOf('-i') + 1] = source;
  args[args.length - 1] = target; // Offline fixture only: never send to a network destination.
  const result = spawnSync(ffmpeg, args, { encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  const inspected = spawnSync(ffmpeg, ['-hide_banner', '-i', target], { encoding: 'utf8' }).stderr;
  assert.match(inspected, /960x540/);
  assert.match(inspected, /Audio: aac/);
  assert.match(result.stdout, /frame=30/);
});
