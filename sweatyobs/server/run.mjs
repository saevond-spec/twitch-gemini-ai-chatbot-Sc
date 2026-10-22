import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { buildMultistreamArgs, validateDestinations } from './multistream.mjs';
import { loadLicensedCatalog, MusicFeeder, createControlServer } from '../encoder/encoder.mjs';
import { pollOnce, applyPacket } from '../encoder/bridge-client.mjs';

// Run only on an operator-controlled Linux host with a private RTMP relay.
// Twitch/YouTube/Kick URLs contain credentials: never log process arguments.
const targetFile = process.env.MULTISTREAM_TARGETS_FILE || '';
if (!targetFile.startsWith('/') || !statSync(targetFile).isFile() || (statSync(targetFile).mode & 0o077)) {
  throw Error('Use an absolute chmod-600 JSON destination file');
}
const destinations = validateDestinations(JSON.parse(readFileSync(targetFile, 'utf8')));
const dir = process.env.LICENSED_MUSIC_DIR || '';
if (!dir.startsWith('/')) throw Error('Use an absolute licensed music directory');
const localToken = process.env.ENCODER_CONTROL_TOKEN || '';
const bridgeToken = process.env.ENCODER_BRIDGE_TOKEN || '';
const encoderApi = process.env.ENCODER_SERVICE_URL || '';
if (localToken.length < 32 || bridgeToken.length < 32 || !/^https:\/\/[^\s/]+\/?$/.test(encoderApi)) {
  throw Error('Strong control tokens and a configured HTTPS encoder API are required');
}
const args = buildMultistreamArgs({
  source: 'rtmp://127.0.0.1:1935/relay/ps5', destinations
});
const ffmpeg = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] });
const feeder = new MusicFeeder({ sink: ffmpeg.stdio[3], stations: loadLicensedCatalog(dir) });
feeder.start();
const control = createControlServer({
  feeder, token: localToken, bind: '127.0.0.1',
  encoderAlive: () => ffmpeg.exitCode === null && !ffmpeg.killed,
});
let cursor = '', misses = 0, polling = false, stopping = false;
const timer = setInterval(async () => {
  if (polling) return;
  polling = true;
  try {
    const packet = await pollOnce({ url: encoderApi, token: bridgeToken, cursor });
    cursor = applyPacket(feeder, packet);
    misses = 0;
  } catch {
    if (++misses >= 3) feeder.command('pause');
    console.error('Music control unavailable; retrying safely');
  } finally { polling = false; }
}, 1500);
let partial = '';
ffmpeg.stderr.setEncoding('utf8');
ffmpeg.stderr.on('data', chunk => {
  partial = (partial + chunk).slice(-5000);
  const lines = partial.split(/\r?\n/);
  partial = lines.pop() || '';
  for (const line of lines) {
    let safe = line;
    for (const item of destinations) safe = safe.replaceAll(item.url, '[PRIVATE]');
    safe = safe.replace(/rtmps?:\/\/[^\s\]]+/gi, '[REDACTED_URL]');
    console.error(safe.slice(0, 450));
  }
});
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  feeder.stop();
  control.close();
  if (ffmpeg.exitCode === null) ffmpeg.kill('SIGTERM');
  process.exitCode = code;
}
ffmpeg.on('error', () => { console.error('FFmpeg startup failed'); stop(1); });
ffmpeg.on('close', code => { console.error('FFmpeg exited', code); stop(code || 1); });
process.on('SIGTERM', () => stop(0));
process.on('SIGINT', () => stop(0));
console.log('Awaiting localhost PS5 RTMP; destinations:', destinations.map(x=>x.platform).join(', '));
