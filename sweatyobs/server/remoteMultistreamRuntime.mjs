import { spawn } from 'node:child_process';
import { buildMultistreamArgs, validateDestinations } from './multistream.mjs';
import { MusicFeeder } from '../encoder/encoder.mjs';

const ACTIONS = new Set(['play', 'pause', 'skip']);
const STATIONS = new Set(['club', 'dubstep']);

function errorCode(error) {
  const message = String(error?.message || '').toLowerCase();
  if (message.includes('auth') || message.includes('denied') || message.includes('401')) return 'AUTH';
  if (message.includes('network') || message.includes('connect') || message.includes('timeout')) return 'NETWORK';
  if (['ENOENT', 'EACCES', 'EPERM'].includes(error?.code)) return 'ENCODER';
  return 'UNKNOWN';
}

function classifyFfmpegError(stderr) {
  const message = String(stderr || '').toLowerCase();
  if (/authentication failed|unauthorized|forbidden|publish.*denied|server returned 40[13]/.test(message)) return 'AUTH';
  if (/connection refused|connection reset|broken pipe|timed out|network is unreachable|could not connect/.test(message)) return 'NETWORK';
  if (/no such file|invalid data found|error opening input|end of file|could not find codec/.test(message)) return 'SOURCE';
  if (/error while|failed to open|encoder not found|unknown encoder/.test(message)) return 'ENCODER';
  return 'UNKNOWN';
}

function safeStderrTail(previous, chunk) {
  const safe = String(chunk)
    .replace(/rtmps?:\/\/[^\s"'<>]+/gi, '[redacted-url]')
    .replace(/(authorization|password|token|stream.?key)\s*[:=]\s*[^\s]+/gi, '$1=[redacted]');
  return (previous + safe).slice(-4096);
}

/**
 * One FFmpeg process per destination. A failed platform can retry independently
 * while healthy outputs continue. LIVE_UNVERIFIED means FFmpeg reports mux
 * progress; it does not claim that a platform dashboard or viewers confirmed it.
 */
export class RemoteMultistreamRuntime {
  constructor({
    destinations,
    stations = { club: [], dubstep: [] },
    source = 'rtmp://127.0.0.1:1935/relay/ps5',
    spawnProcess = spawn,
    createFeeder = options => new MusicFeeder(options),
    baseDelayMs = 1000,
    maxDelayMs = 30_000,
    random = Math.random,
    now = () => Date.now(),
    connectTimeoutMs = 30_000,
    progressTimeoutMs = 15_000,
    schedule = setTimeout,
    cancel = clearTimeout,
  } = {}) {
    this.destinations = validateDestinations(destinations);
    if (this.destinations.length > 3) throw new Error('At most three platform outputs are supported');
    this.source = source;
    buildMultistreamArgs({ source: this.source, destinations: [this.destinations[0]] });
    this.stations = stations;
    this.spawnProcess = spawnProcess;
    this.createFeeder = createFeeder;
    this.baseDelayMs = Math.max(1, baseDelayMs);
    this.maxDelayMs = Math.max(this.baseDelayMs, maxDelayMs);
    this.random = random;
    this.now = now;
    this.connectTimeoutMs = Math.max(1000, connectTimeoutMs);
    this.progressTimeoutMs = Math.max(1000, progressTimeoutMs);
    this.schedule = schedule;
    this.cancel = cancel;
    this.desiredRunning = false;
    this.music = { station: '', playing: false };
    this.slots = this.destinations.map(({ platform }) => ({
      platform, state: 'STOPPED', errorCode: 'NONE', reconnects: 0, droppedPackets: null, bitrateKbps: null,
      failures: 0, child: null, feeder: null, retryTimer: null, generation: 0,
      finishedGeneration: 0, intentionalRestart: false, progress: false, progressAt: 0,
      startedAt: 0, stallTermination: '', progressBuffer: '', stderrTail: '',
    }));
  }

  start() {
    if (this.desiredRunning) return this.status();
    this.desiredRunning = true;
    for (const slot of this.slots) this.startTarget(slot);
    return this.status();
  }

  stop() {
    this.desiredRunning = false;
    for (const slot of this.slots) {
      if (slot.retryTimer) this.cancel(slot.retryTimer);
      slot.retryTimer = null;
      slot.progress = false;
      slot.bitrateKbps = null;
      slot.state = 'STOPPED';
      slot.errorCode = 'NONE';
      slot.feeder?.stop();
      slot.feeder = null;
      if (slot.child && slot.child.exitCode === null) {
        slot.intentionalRestart = true;
        slot.child.kill('SIGTERM');
      } else {
        slot.intentionalRestart = false;
        slot.child = null;
      }
    }
    return this.status();
  }

  reconnect() {
    if (!this.desiredRunning) return { accepted: false, ...this.status() };
    for (const slot of this.slots) {
      if (slot.retryTimer) this.cancel(slot.retryTimer);
      slot.retryTimer = null;
      slot.reconnects++;
      slot.progress = false;
      slot.state = 'CONNECTING';
      if (slot.child && slot.child.exitCode === null) {
        slot.intentionalRestart = true;
        slot.feeder?.stop();
        slot.feeder = null;
        slot.child.kill('SIGTERM');
      } else {
        slot.child = null;
        this.startTarget(slot);
      }
    }
    return { accepted: true, ...this.status() };
  }

  command(action, station) {
    if (action === 'station') {
      if (!STATIONS.has(station)) throw new Error('Unsupported music station');
      this.music = { station, playing: true };
    } else {
      if (!ACTIONS.has(action)) throw new Error('Unsupported music action');
      this.music = { ...this.music, playing: action === 'play' ? true : action === 'pause' ? false : this.music.playing };
    }
    for (const slot of this.slots) {
      if (!slot.feeder) continue;
      if (action === 'station') slot.feeder.command('station', station);
      else slot.feeder.command(action);
    }
    return this.status();
  }

  checkHealth() {
    if (!this.desiredRunning) return;
    const now = this.now();
    for (const slot of this.slots) {
      if (!slot.child || slot.intentionalRestart || slot.stallTermination) continue;
      const reference = slot.progress ? slot.progressAt : slot.startedAt;
      const timeout = slot.progress ? this.progressTimeoutMs : this.connectTimeoutMs;
      if (reference > 0 && now - reference >= timeout) {
        slot.progress = false;
        slot.state = 'RETRYING';
        slot.errorCode = 'NETWORK';
        slot.stallTermination = 'NETWORK';
        slot.child.kill('SIGTERM');
      }
    }
  }

  status() {
    const active = this.slots.some(slot => slot.progress);
    let state = 'STOPPED';
    if (this.desiredRunning) {
      if (active) state = 'RUNNING_UNVERIFIED';
      else if (this.slots.some(slot => slot.state === 'RETRYING')) state = 'RETRYING';
      else if (this.slots.some(slot => slot.state === 'FAILED')) state = 'FAILED';
      else if (this.slots.some(slot => slot.state === 'CONNECTING')) state = 'STARTING';
    }
    return {
      state,
      desiredRunning: this.desiredRunning,
      outputProgress: active,
      outputs: this.slots.map(slot => ({
        platform: slot.platform,
        state: !this.desiredRunning ? 'STOPPED' : slot.progress ? 'LIVE_UNVERIFIED' : slot.state,
        bitrateKbps: slot.bitrateKbps,
        reconnects: slot.reconnects,
        droppedPackets: slot.droppedPackets,
        errorCode: slot.errorCode,
      })),
    };
  }

  startTarget(slot) {
    if (!this.desiredRunning || slot.retryTimer) return;
    if (slot.child) {
      // A Stop followed immediately by Start waits for the old child to close.
      // Keep the visible state honest while that intentional restart is pending.
      if (slot.intentionalRestart) {
        slot.state = 'CONNECTING';
        slot.errorCode = 'NONE';
        slot.progress = false;
      }
      return;
    }
    const destination = this.destinations.find(item => item.platform === slot.platform);
    const generation = ++slot.generation;
    slot.state = 'CONNECTING';
    slot.errorCode = 'NONE';
    slot.progress = false;
    slot.bitrateKbps = null;
    slot.progressAt = 0;
    slot.startedAt = this.now();
    slot.stallTermination = '';
    slot.progressBuffer = '';
    slot.stderrTail = '';
    try {
      const args = buildMultistreamArgs({ source: this.source, destinations: [destination] });
      const child = this.spawnProcess('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
      slot.child = child;
      slot.feeder = this.createFeeder({ sink: child.stdio[3], stations: this.stations });
      slot.feeder.start();
      if (this.music.station) {
        slot.feeder.command('station', this.music.station);
        if (!this.music.playing) slot.feeder.command('pause');
      } else if (this.music.playing) slot.feeder.command('play');
      child.stderr?.setEncoding?.('utf8');
      child.stderr?.on?.('data', chunk => {
        if (slot.generation === generation) slot.stderrTail = safeStderrTail(slot.stderrTail, chunk);
      });
      if (child.stderr?.resume) child.stderr.resume();
      child.stdout?.setEncoding?.('utf8');
      child.stdout?.on?.('data', chunk => this.readProgress(slot, generation, chunk));
      child.on('error', error => this.finishTarget(slot, generation, errorCode(error)));
      child.on('close', code => this.finishTarget(slot, generation,
        code === 0 ? 'UNKNOWN' : classifyFfmpegError(slot.stderrTail)));
    } catch (error) {
      if (slot.child && slot.child.exitCode === null) slot.child.kill('SIGTERM');
      this.finishTarget(slot, generation, errorCode(error));
    }
  }

  readProgress(slot, generation, chunk) {
    if (slot.generation !== generation || !this.desiredRunning) return;
    slot.progressBuffer = (slot.progressBuffer + String(chunk)).slice(-4096);
    const lines = slot.progressBuffer.split(/\r?\n/);
    slot.progressBuffer = lines.pop() || '';
    const frameProgress = lines.some(line => {
      if (line.startsWith('frame=')) return Number(line.slice(6)) > 0;
      if (line.startsWith('out_time_ms=')) return Number(line.slice(12)) > 0;
      return false;
    });
    for (const line of lines) {
      if (!line.startsWith('bitrate=')) continue;
      const match = line.match(/^bitrate=\s*([\d.]+)kbits\/s$/);
      if (match && Number.isFinite(Number(match[1]))) slot.bitrateKbps = Math.max(0, Math.round(Number(match[1])));
    }
    if (frameProgress) {
      slot.progress = true;
      slot.progressAt = this.now();
      slot.state = 'LIVE_UNVERIFIED';
      slot.errorCode = 'NONE';
      slot.failures = 0;
    }
  }

  finishTarget(slot, generation, code) {
    if (slot.generation !== generation || slot.finishedGeneration === generation) return;
    slot.finishedGeneration = generation;
    slot.feeder?.stop();
    slot.feeder = null;
    slot.child = null;
    slot.progress = false;
    slot.bitrateKbps = null;
    if (slot.stallTermination) code = slot.stallTermination;
    slot.stallTermination = '';
    if (slot.intentionalRestart) {
      slot.intentionalRestart = false;
      if (this.desiredRunning) this.startTarget(slot);
      else {
        slot.state = 'STOPPED';
        slot.errorCode = 'NONE';
      }
      return;
    }
    if (!this.desiredRunning) {
      slot.state = 'STOPPED';
      slot.errorCode = 'NONE';
      return;
    }
    slot.failures++;
    slot.state = 'RETRYING';
    slot.errorCode = code;
    this.scheduleRetry(slot);
  }

  scheduleRetry(slot) {
    if (!this.desiredRunning || slot.retryTimer) return;
    const exponent = Math.min(10, Math.max(0, slot.failures - 1));
    const ceiling = Math.min(this.maxDelayMs, this.baseDelayMs * (2 ** exponent));
    const jitter = Math.max(0, Math.min(0.999999, Number(this.random()) || 0));
    slot.retryTimer = this.schedule(() => {
      slot.retryTimer = null;
      this.startTarget(slot);
    }, Math.floor(ceiling * jitter));
    slot.retryTimer?.unref?.();
  }
}
