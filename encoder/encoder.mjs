import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';

export const SAMPLE_RATE = 48000;
export const FRAME_BYTES = 3840; // 20ms stereo 16-bit PCM at 48kHz
const STATIONS = ['dubstep', 'club'];

export function buildFfmpegArgs({ source, target, copyVideo = true, musicGain = 0.22, allowLocalOutput = false }) {
  if (typeof source !== 'string' || !(/^(rtmp|rtmps|srt):\/\//i.test(source) || isAbsolute(source))) {
    throw new Error('GAMEPLAY_SOURCE must be RTMP/RTMPS/SRT or an absolute video filename');
  }
  if (typeof target !== 'string' || !(/^rtmps?:\/\//i.test(target) || (allowLocalOutput && isAbsolute(target) && target.endsWith('.flv')))) {
    throw new Error('Output must be RTMP/RTMPS');
  }
  if (!Number.isFinite(musicGain) || musicGain < 0 || musicGain > 1) throw new Error('Invalid music gain');
  const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin'];
  if (isAbsolute(source)) args.push('-re');
  args.push('-thread_queue_size', '512', '-i', source,
    '-thread_queue_size', '512', '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '2', '-i', 'pipe:3',
    '-filter_complex', '[0:a:0]aresample=' + SAMPLE_RATE + '[game];[1:a:0]volume=' + musicGain +
      '[music];[game][music]amix=inputs=2:duration=first:dropout_transition=0[mixed]',
    '-map', '0:v:0', '-map', '[mixed]');
  if (copyVideo) args.push('-c:v', 'copy');
  else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p');
  args.push('-c:a', 'aac', '-b:a', '160k', '-ar', String(SAMPLE_RATE), '-f', 'flv', target);
  return args;
}

export function loadLicensedCatalog(directory) {
  const catalog = JSON.parse(readFileSync(join(directory, 'catalog.json'), 'utf8'));
  const result = {};
  for (const station of STATIONS) {
    const entries = catalog[station] || [];
    if (!Array.isArray(entries) || entries.length > 100) throw new Error('Invalid catalog');
    result[station] = entries.map(entry => {
      if (typeof entry?.file !== 'string' || !/^[a-zA-Z0-9_-]+\.(mp3|wav|ogg|flac)$/.test(entry.file)) {
        throw new Error('Invalid track filename');
      }
      if (typeof entry.rights !== 'string' || entry.rights.trim().length < 12) {
        throw new Error('Each track requires documentation of stream and VOD rights');
      }
      const filename = join(directory, entry.file);
      if (!existsSync(filename) || !statSync(filename).isFile()) throw new Error('Missing licensed track: ' + entry.file);
      return { filename, title: basename(entry.file), rights: entry.rights };
    });
  }
  return result;
}

export function safeTokenEqual(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || expected.length < 32) return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class MusicFeeder {
  constructor({ sink, stations, spawnProcess = spawn }) {
    this.sink = sink;
    this.stations = stations;
    this.spawnProcess = spawnProcess;
    this.station = 'dubstep';
    this.index = 0;
    this.playing = false;
    this.decoder = null;
    this.generation = 0;
    this.queue = [];
    this.available = 0;
    this.timer = null;
    this.retryTimer = null;
  }
  status() {
    return { station: this.station, playing: this.playing,
      currentTrack: this.currentTrack || '', tracks: (this.stations[this.station] || []).length };
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.sink.destroyed) return this.stop();
      const frame = Buffer.alloc(FRAME_BYTES);
      if (this.playing) this.readInto(frame);
      if (!this.sink.write(frame)) {
        clearInterval(this.timer);
        this.timer = null;
        this.sink.once('drain', () => { if (!this.sink.destroyed) this.start(); });
      }
    }, 20);
  }
  readInto(frame) {
    let written = 0;
    while (written < frame.length && this.queue.length) {
      const head = this.queue[0];
      const take = Math.min(head.length, frame.length - written);
      head.copy(frame, written, 0, take);
      written += take;
      this.available -= take;
      if (take === head.length) this.queue.shift();
      else this.queue[0] = head.subarray(take);
    }
    if (this.decoder?.stdout?.isPaused() && this.available < FRAME_BYTES * 30) this.decoder.stdout.resume();
  }
  clearDecoder() {
    this.generation++;
    clearTimeout(this.retryTimer);
    if (this.decoder) this.decoder.kill('SIGTERM');
    this.decoder = null;
    this.queue = [];
    this.available = 0;
    this.currentTrack = '';
  }
  decodeTrack() {
    if (!this.playing || this.decoder) return;
    const list = this.stations[this.station] || [];
    if (!list.length) return;
    const track = list[this.index % list.length];
    const generation = ++this.generation;
    this.currentTrack = track.title;
    const decoder = this.spawnProcess('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', track.filename,
      '-vn', '-f', 's16le', '-acodec', 'pcm_s16le', '-ar', String(SAMPLE_RATE), '-ac', '2', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    this.decoder = decoder;
    decoder.on('error', () => {});
    decoder.stdout?.on('data', chunk => {
      if (generation !== this.generation) return;
      this.queue.push(chunk);
      this.available += chunk.length;
      if (this.available > FRAME_BYTES * 200) decoder.stdout.pause();
    });
    decoder.on('close', () => {
      if (generation !== this.generation) return;
      this.decoder = null;
      this.currentTrack = '';
      this.index = (this.index + 1) % list.length;
      if (this.playing) this.retryTimer = setTimeout(() => this.decodeTrack(), 350);
    });
  }
  command(action, station) {
    if (action === 'station') {
      if (!STATIONS.includes(station)) throw new Error('Unknown station');
      this.clearDecoder();
      this.station = station;
      this.index = 0;
      this.playing = true;
      this.decodeTrack();
    } else if (action === 'play') {
      this.playing = true;
      this.decodeTrack();
    } else if (action === 'pause') {
      this.playing = false;
      this.clearDecoder();
    } else if (action === 'skip') {
      this.clearDecoder();
      const count = (this.stations[this.station] || []).length;
      if (count) this.index = (this.index + 1) % count;
      this.decodeTrack();
    } else throw new Error('Unknown control command');
    return this.status();
  }
  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.playing = false;
    this.clearDecoder();
  }
}

export function createControlServer({ feeder, token, bind = '127.0.0.1', port = 8787, encoderAlive = () => false }) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('ENCODER_CONTROL_TOKEN needs 32+ characters');
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/health') {
      res.end(JSON.stringify({ encoderAlive: Boolean(encoderAlive()), ...feeder.status() }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/control') {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    const header = req.headers.authorization || '';
    if (!safeTokenEqual(header.startsWith('Bearer ') ? header.slice(7) : '', token)) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    let length = 0, data = '';
    req.on('data', chunk => {
      length += chunk.length;
      if (length > 2048) return req.destroy();
      data += chunk;
    });
    req.on('end', () => {
      try {
        const { action, station } = JSON.parse(data);
        res.end(JSON.stringify({ ok: true, state: feeder.command(action, station) }));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  });
  server.listen(port, bind);
  return server;
}
