import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFfmpegArgs, safeTokenEqual, loadLicensedCatalog } from '../encoder/encoder.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('FFmpeg plan mixes incoming gameplay audio with local 48k stereo music', () => {
  const args = buildFfmpegArgs({ source: 'rtmp://127.0.0.1:1935/gameplay/live', target: 'rtmps://example.test/app/streamkey' });
  assert.ok(args.includes('pipe:3'));
  assert.ok(args.includes('amix=inputs=2:duration=first:dropout_transition=0[mixed]') === false);
  assert.match(args[args.indexOf('-filter_complex') + 1], /amix=inputs=2:duration=first/);
  assert.ok(args.includes('copy'));
  assert.equal(args.at(-1), 'rtmps://example.test/app/streamkey');
});
test('rejects unsafe sources, outputs and music volume', () => {
  assert.throws(() => buildFfmpegArgs({ source: 'https://video.example/live', target: 'rtmp://example/live' }));
  assert.throws(() => buildFfmpegArgs({ source: '/tmp/input.mp4', target: '/tmp/out.flv' }));
  assert.throws(() => buildFfmpegArgs({ source: '/tmp/input.mp4', target: 'rtmp://example/live', musicGain: 2 }));
});
test('control token comparison requires a strong exact match', () => {
  const token = 'z'.repeat(44);
  assert.equal(safeTokenEqual(token, token), true);
  assert.equal(safeTokenEqual(token.slice(1), token), false);
  assert.equal(safeTokenEqual('x', 'x'), false);
});
test('catalog disallows traversal and requires rights and local tracks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'enc-'));
  try {
    writeFileSync(join(dir, 'test.mp3'), 'mock fixture');
    writeFileSync(join(dir, 'catalog.json'), JSON.stringify({ dubstep: [{ file: 'test.mp3', rights: 'Licensed for livestreams, VOD and clips' }], club: [] }));
    assert.equal(loadLicensedCatalog(dir).dubstep.length, 1);
    writeFileSync(join(dir, 'catalog.json'), JSON.stringify({ dubstep: [{ file: '../secret.mp3', rights: 'Licensed for livestreams, VOD and clips' }] }));
    assert.throws(() => loadLicensedCatalog(dir));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
