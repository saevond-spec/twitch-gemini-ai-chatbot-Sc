import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { buildFfmpegArgs, createControlServer, loadLicensedCatalog, MusicFeeder } from './encoder.mjs';

const source = process.env.GAMEPLAY_SOURCE || '';
const target = process.env.TWITCH_RTMP_URL || '';
const token = process.env.ENCODER_CONTROL_TOKEN || '';
const dir = process.env.LICENSED_MUSIC_DIR || './licensed-music';
const stations = loadLicensedCatalog(dir);
const args = buildFfmpegArgs({
  source, target,
  copyVideo: process.env.ENCODER_COPY_VIDEO !== 'false',
  musicGain: Number(process.env.MUSIC_GAIN || '0.22'),
});
const mixer = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'inherit', 'pipe'] });
const sink = mixer.stdio[3];
const feeder = new MusicFeeder({ sink, stations });
feeder.start();
const control = createControlServer({
  feeder, token, port: Number(process.env.ENCODER_CONTROL_PORT || '8787'),
  encoderAlive: () => mixer.exitCode === null && !mixer.killed,
});
mixer.on('error', error => { console.error('Encoder spawn failed:', error.message); shutdown(1); });
mixer.on('close', code => { console.error('Encoder stopped:', code); shutdown(code || 1); });
function shutdown(code = 0) {
  feeder.stop();
  control.close();
  if (mixer.exitCode === null) mixer.kill('SIGTERM');
  process.exitCode = code;
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
console.log('Encoder running; local control endpoint is 127.0.0.1:' + (process.env.ENCODER_CONTROL_PORT || 8787));
