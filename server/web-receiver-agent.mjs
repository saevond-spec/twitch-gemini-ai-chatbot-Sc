// Run next to the existing nginx PS5 ingest configuration, not on an HTTP-only host.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { normalizeProfile } from '../src/encoder/receiverControl.js';
import { validateRelay } from '../src/encoder/obsWebControl.js';

export function receiverArgs(action, input) {
  if (!['diagnostic', 'start', 'reconnect'].includes(action)) throw Error('Unknown receiver action');
  const settings = validateRelay(input);
  const p = normalizeProfile(settings.profile);
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-progress', 'pipe:1',
    '-rw_timeout', '15000000', '-i', 'rtmp://127.0.0.1:1935/relay/ps5'];
  if (action === 'diagnostic') return args.concat(['-map', '0:v:0', '-map', '0:a:0?', '-f', 'null', '-']);
  if (!settings.streamKey) throw Error('Missing stream key');
  if (p.quality === 'passthrough') {
    if (p.rotate180 || p.overlay) throw Error('Overlay and rotation require an encoded quality profile');
    args.push('-c:v', 'copy');
  } else {
    const sizes = { '540p30': [960, 540, 1800], '720p30': [1280, 720, 3200], '1080p30': [1920, 1080, 4500] };
    const [width, height, kbps] = sizes[p.quality];
    const filters = [];
    if (p.rotate180) filters.push('hflip', 'vflip');
    filters.push(`scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`);
    if (p.overlay) filters.push('drawbox=x=0:y=0:w=iw:h=ih:color=magenta@0.6:t=5',
      'drawtext=text=@saevond:x=20:y=20:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.6');
    args.push('-vf', filters.join(','), '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
      '-pix_fmt', 'yuv420p', '-r', '30', '-g', '60', '-b:v', kbps + 'k', '-maxrate', kbps + 'k', '-bufsize', kbps * 2 + 'k');
  }
  const target = settings.relayUrl.replace(/\/$/, '') + '/' + encodeURIComponent(settings.streamKey);
  return args.concat(['-map', '0:v:0', '-map', '0:a:0?', '-af', `volume=${p.gameVolume / 100},alimiter=limit=0.95:level=false`,
    '-c:a', 'aac', '-ar', '48000', '-b:a', '128k', '-f', 'flv', target]);
}

export async function runAgent(env = process.env) {
  const base = new URL(env.OBS_DASHBOARD_URL || '');
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw Error('Use the HTTPS dashboard origin');
  const token = env.ENCODER_BRIDGE_TOKEN || '';
  if (token.length < 32) throw Error('Matching ENCODER_BRIDGE_TOKEN of at least 32 characters required');
  const id = randomUUID();
  let child = null, state = 'STOPPED', frames = 0, revision = 0, ack = null, lastId = null;
  let lastContact = Date.now(), stopping = false;
  async function stop() {
    const prior = child; child = null; state = 'STOPPED'; frames = 0;
    if (!prior || prior.exitCode !== null) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => prior.kill('SIGKILL'), 3000);
      prior.once('close', () => { clearTimeout(timer); resolve(); });
      prior.kill('SIGTERM');
    });
  }
  async function execute(command) {
    if (command.id === lastId || command.expiresAt <= Date.now()) return;
    lastId = command.id;
    await stop();
    if (command.action !== 'stop') {
      try {
        const args = receiverArgs(command.action, command.settings);
        state = 'STARTING';
        const current = spawn(env.OBS_FFMPEG_PATH || 'ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        child = current;
        let buffer = '';
        current.stdout.on('data', data => {
          if (child !== current) return;
          buffer = (buffer + data).slice(-4096);
          const lines = buffer.split(/\r?\n/); buffer = lines.pop();
          for (const line of lines) {
            if (/^frame=\d+$/.test(line)) {
              frames = Number(line.slice(6));
              if (frames > 0) state = command.action === 'diagnostic' ? 'DIAGNOSTIC' : 'STREAMING';
            }
          }
        });
        // FFmpeg stderr can contain the destination key. Never forward or log it.
        current.stderr.on('data', () => {});
        current.on('error', () => { if (child === current) state = 'FAILED'; });
        current.on('close', () => { if (child === current) { child = null; state = 'FAILED'; frames = 0; } });
      } catch { state = 'FAILED'; }
    }
    revision = command.revision; ack = command.id;
  }
  const watchdog = setInterval(() => {
    if (Date.now() - lastContact > 30000 && child) void stop();
  }, 1000);
  const shutdown = () => { stopping = true; void stop(); };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
  try {
    while (!stopping) {
      try {
        const response = await fetch(new URL('/api/obs-web/receiver/poll', base), {
          method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, state, frames, revision, ack }), signal: AbortSignal.timeout(8000)
        });
        if (!response.ok) throw Error('Control connection unavailable');
        const data = await response.json(); lastContact = Date.now();
        if (data.command) await execute(data.command);
      } catch { /* Watchdog stops publishing if the control connection is lost. */ }
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  } finally { clearInterval(watchdog); await stop(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAgent().catch(() => { console.error('Receiver agent could not start. Check dashboard URL, token and FFmpeg installation.'); process.exitCode = 1; });
}
