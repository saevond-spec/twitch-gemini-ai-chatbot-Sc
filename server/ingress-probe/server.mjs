import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { authorizePublisher, buildRelayArgs, relayConfiguration } from './sleipnir-relay.mjs';
import { fetchSelectedMusic, writeMusicPlaylist } from './music-playlist.mjs';

const began = Date.now();
const lifetimeMs = 12 * 60 * 1000;
// NGINX accepts concurrent RTMP connections and never records media.
const status = {
  mode: 'diagnostic_only',
  price: '$0 free tunnel (subject to provider limits)',
  startedAt: new Date(began).toISOString(),
  expiresAt: new Date(began + lifetimeMs).toISOString(),
  publicEndpoint: null,
  tunnel: 'STARTING',
  mediaReceiver: 'STARTING',
  frames: 0,
  inboundBytes: 0,
  syntheticProbe: 'NOT_RUN',
  output: 'no recording; Sleipnir relay is disabled unless explicitly configured',
  relay: relayConfiguration().ready ? 'ARMED_WAITING_FOR_AUTHENTICATED_PUBLISHER' : 'DISABLED',
  relayFrames: 0,
  musicMode: 'NOT_CHECKED',
  selectedMusicCount: 0,
  publicSmoke: 'NOT_REQUESTED',
  authRejectionProbe: 'NOT_RUN',
  outputVerified: false,
  ps5Connected: false,
  notes: 'A public endpoint alone does not prove PS5 native broadcast can be redirected to this host and port.'
};
const children = new Set();
let stopped = false;
let relayChild = null;
let relayStarting = false;
const endpointRe = /tcp:\/\/([a-z0-9][a-z0-9.-]*):(\d{2,5})/i;
const safeError = error => (error && error.code ? String(error.code) : 'PROCESS_ERROR');

function spawnTracked(binary, args, handlers = {}) {
  const proc = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(proc);
  proc.stdout.on('data', data => handlers.data?.(String(data)));
  proc.stderr.on('data', data => handlers.stderr?.(String(data)));
  proc.on('error', err => handlers.error?.(err));
  proc.on('close', code => { children.delete(proc); handlers.close?.(code); });
  return proc;
}

function launchMediaReceiver() {
  if (stopped) return;
  status.mediaReceiver = 'STARTING_NGINX';
  spawnTracked('nginx', ['-c','/etc/nginx/nginx.conf','-g','daemon off;'], {
    stderr(data) {
      for (const line of data.split(/\r?\n/)) {
        if (/emerg|alert|crit|failed|denied/i.test(line)) {
          console.log('RTMP_NGINX_DIAGNOSTIC ' + line.replace(/[^\x20-\x7e]/g, '').slice(0, 240));
        }
      }
    },
    error(error) { status.mediaReceiver = 'ERROR_' + safeError(error); },
    close(code) { if (!stopped) status.mediaReceiver = 'NGINX_EXITED_' + String(code); }
  });
  const statTimer = setInterval(async () => {
    if (stopped) { clearInterval(statTimer); return; }
    try {
      const response = await fetch('http://127.0.0.1:8088/stat', { signal: AbortSignal.timeout(1500) });
      if (!response.ok) throw Error('stats HTTP status ' + response.status);
      const xml = await response.text();
      const stream = xml.match(/<bytes_in>(\d+)<\/bytes_in>/);
      const inboundBytes = stream ? Number(stream[1]) : 0;
      if (Number.isSafeInteger(inboundBytes) && inboundBytes > status.inboundBytes) status.inboundBytes = inboundBytes;
      status.mediaReceiver = /<publishing\s*\/>/.test(xml) ? 'RTMP_PUBLISHER_CONNECTED' : 'NGINX_LISTENING';
    } catch { status.mediaReceiver = 'NGINX_STATS_UNREACHABLE'; }
  }, 4000);
}

function launchAuthRejectionProbe() {
  if (stopped || status.authRejectionProbe !== 'NOT_RUN') return;
  status.authRejectionProbe = 'RUNNING';
  // Deliberately invalid publish name. This must not start an outbound relay.
  // Local RTMP path avoids revealing private configuration over the public tunnel.
  spawnTracked('ffmpeg', [
    '-hide_banner','-nostdin','-loglevel','error',
    '-f','lavfi','-i','color=c=black:s=160x90:r=5',
    '-t','1','-c:v','libx264','-preset','ultrafast',
    '-pix_fmt','yuv420p','-f','flv',
    'rtmp://127.0.0.1:1935/secure/unauthorized-diagnostic-test'
  ], {
    // The sender's arguments are fixed; stderr is intentionally discarded.
    stderr() {},
    error() { status.authRejectionProbe = 'ERROR'; },
    close(code) {
      status.authRejectionProbe = code !== 0 ? 'REJECTED_AS_EXPECTED' : 'FAILED_OPEN';
      console.log('RTMP_AUTH_REJECTION_TEST ' + status.authRejectionProbe);
      if (status.authRejectionProbe === 'FAILED_OPEN') {
        // Do not make the secured endpoint available when auth unexpectedly fails.
        status.relay = 'SECURITY_CHECK_FAILED';
        stop();
      }
    }
  });
}
function launchSleipnirSmokeTest() {
  // Explicit opt-in is required. A generated moving test pattern with silent
  // audio is paced in real time for at most 25 seconds. It never accesses PS5 gameplay.
  if (stopped || process.env.OBS_PUBLIC_SMOKE_TEST !== 'true' || !relayConfiguration().ready) return;
  if (status.authRejectionProbe !== 'REJECTED_AS_EXPECTED') {
    console.log('RTMP_LIVE_SMOKE_SKIPPED_SECURITY_CHECK');
    return;
  }
  const secretToken = relayConfiguration().publishToken;
  status.publicSmoke = 'STARTED';
  // The local NGINX on_publish callback authorizes only this exact token.
  spawnTracked('ffmpeg', [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-re','-f','lavfi','-i','testsrc2=s=640x360:r=30',
    '-re','-f','lavfi','-i','anullsrc=channel_layout=stereo:sample_rate=48000',
    '-t','25','-map','0:v:0','-map','1:a:0',
    '-c:v','libx264','-preset','ultrafast','-tune','zerolatency',
    '-pix_fmt','yuv420p','-g','60','-b:v','600k',
    '-c:a','aac','-b:a','96k',
    '-f','flv', 'rtmp://127.0.0.1:1935/secure/' + secretToken
  ], {
    // Suppress stderr; arguments contain a private publish token.
    stderr() {},
    error() { status.publicSmoke = 'PROCESS_ERROR'; },
    close(code) {
      status.publicSmoke = code === 0 ? 'SENT_TO_PROTECTED_LOCAL_INGEST' : 'FAILED_EXIT_' + String(code);
      console.log('RTMP_LIVE_SMOKE ' + status.publicSmoke);
    }
  });
}

function launchSyntheticProbe(endpoint) {
  if (stopped || status.syntheticProbe !== 'NOT_RUN') return;
  status.syntheticProbe = 'STARTING';
  const url = endpoint.replace(/^tcp:\/\//, 'rtmp://') + '/app/synthetic-connection-test';
  setTimeout(() => {
    if (stopped) return;
    spawnTracked('ffmpeg', [
      '-hide_banner','-nostdin','-loglevel','error',
      '-f','lavfi','-i','color=c=black:s=160x90:r=5',
      '-t','2','-c:v','libx264','-preset','ultrafast',
      '-pix_fmt','yuv420p','-f','flv',url
    ], {
      error(error) { status.syntheticProbe = 'FAILED_' + safeError(error); },
      close(code) {
        status.syntheticProbe = code === 0 ? 'PUBLISHED_THROUGH_PUBLIC_TCP' : 'FAILED_EXIT_' + String(code);
        console.log('RTMP_SYNTHETIC_PROBE ' + status.syntheticProbe);
      }
    });
  }, 4000);
}

async function startProtectedRelay() {
  if (stopped || relayChild || relayStarting || !relayConfiguration().ready) return;
  relayStarting = true;
  status.musicMode = 'CHECKING_APPROVED_SELECTION';
  const selected = await fetchSelectedMusic();
  if (stopped) { relayStarting = false; return; }
  status.musicMode = selected.status;
  let options = {};
  if (selected.profile) {
    options.gameVolume = selected.profile.gameVolume;
    options.overlay = selected.profile.overlay;
    if (selected.status === 'READY') {
      try {
        const playlistPath = await writeMusicPlaylist(selected.profile);
        options.music = {
          playlistPath, volume:selected.profile.volume,
          autoNext:selected.profile.autoNext
        };
        status.selectedMusicCount = selected.profile.selected.length;
        status.musicMode = 'MIXING_SELECTED_TRACKS';
      } catch {
        status.musicMode = 'PLAYLIST_UNAVAILABLE_GAME_AUDIO_ONLY';
      }
    }
  }
  // A short test uses only synthesized tone and a fixed branding overlay.
  // It never imports unverified music files or changes saved user preferences.
  if (process.env.OBS_PUBLIC_SMOKE_TEST === 'true' &&
      process.env.OBS_OVERLAY_MIX_SMOKE_TEST === 'true') {
    options.syntheticTestTone = true;
    options.overlay = true;
    status.musicMode = 'SYNTHETIC_TONE_TEST_ONLY';
  }
  if (stopped) { relayStarting = false; return; }
  let args;
  try { args = buildRelayArgs(process.env,options); }
  catch { relayStarting = false; return; }
  status.relay = 'CONNECTING_TO_SLEIPNIR';
  status.relayFrames = 0;
  let buffer = '';
  const child = spawnTracked('ffmpeg', args, {
    data(chunk) {
      buffer = (buffer + chunk).slice(-2048);
      const lines = buffer.split(/\r?\n/); buffer = lines.pop();
      for (const line of lines) {
        if (/^frame=\d+$/.test(line)) {
          const count = Number(line.slice(6));
          if (Number.isSafeInteger(count) && count > status.relayFrames) {
            status.relayFrames = count;
            status.relay = 'MEDIA_SENDING_TO_SLEIPNIR_UNVERIFIED_PLAYBACK';
          }
        }
      }
    },
    // FFmpeg stderr may contain a stream key; never log it.
    stderr() {},
    error(error) { status.relay = 'ERROR_' + safeError(error); },
    close(code) {
      if (relayChild === child) {
        relayChild = null;
        status.relay = 'STOPPED_EXIT_' + String(code);
        // No automatic restart or retry: requires another authenticated publish.
      }
    }
  });
  relayChild = child;
  relayStarting = false;
}

function launchTunnel() {
  // Ephemeral SSH key used exclusively for this 12-minute outbound tunnel.
  const key = '/tmp/obs-free-ingress-key';
  const start = () => {
    const ssh = spawnTracked('ssh', [
      '-T','-p','443','-i',key,
      '-o','StrictHostKeyChecking=accept-new',
      '-o','UserKnownHostsFile=/tmp/obs-ingress-known-hosts',
      '-o','ServerAliveInterval=20','-o','ServerAliveCountMax=2',
      '-o','ExitOnForwardFailure=yes',
      '-R','0:127.0.0.1:1935','tcp@free.pinggy.io'
    ], {
      data: parseTunnel,
      stderr: parseTunnel,
      error(error) { status.tunnel = 'ERROR_' + safeError(error); },
      close(code) {
        if (!stopped) {
          status.publicEndpoint = null;
          status.tunnel = 'DISCONNECTED_' + String(code);
          console.log('RTMP_TUNNEL_DISCONNECTED ' + String(code));
        }
      }
    });
    return ssh;
  };
  function parseTunnel(message) {
    // Never display arbitrary SSH output: it can include sensitive data.
    const match = endpointRe.exec(message);
    if (match) {
      const port = Number(match[2]);
      if (port > 0 && port <= 65535) {
        status.publicEndpoint = 'tcp://' + match[1].toLowerCase() + ':' + port;
        status.tunnel = 'PUBLIC_TCP_ASSIGNED';
        console.log('RTMP_INGRESS_READY ' + status.publicEndpoint);
        launchSyntheticProbe(status.publicEndpoint);
        setTimeout(launchAuthRejectionProbe, 7000);
        setTimeout(launchSleipnirSmokeTest, 13000);
      }
    }
  }
  if (existsSync(key)) return start();
  spawnTracked('ssh-keygen', ['-q','-t','ed25519','-N','','-f',key], {
    close(code) { if (code === 0 && !stopped) start(); else status.tunnel = 'SSH_KEY_UNAVAILABLE'; },
    error(error) { status.tunnel = 'SSH_KEY_ERROR_' + safeError(error); }
  });
}

const server = http.createServer((req, res) => {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  if (req.url === '/authorize-publish' && req.method === 'POST') {
    // Auth callback is loopback-only; the public HTTP service cannot invoke it.
    // Do not reflect the publisher's name or stream key.
    const remote = req.socket.remoteAddress;
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
      res.writeHead(403); res.end(); return;
    }
    let payload = '';
    req.on('data', chunk => {
      payload += String(chunk);
      if (payload.length > 4096) req.destroy();
    });
    req.on('end', () => {
      const permitted = !stopped && !relayChild && !relayStarting && authorizePublisher(payload);
      res.writeHead(permitted ? 200 : 403); res.end();
      if (permitted) setTimeout(startProtectedRelay, 1000);
    });
    return;
  }
  if (req.url === '/' || req.url === '/status' || req.url === '/healthz') {
    res.setHeader('Content-Type','application/json; charset=utf-8');
    res.writeHead(200);
    res.end(JSON.stringify({ ...status, remainingSeconds: Math.max(0, Math.floor((began + lifetimeMs - Date.now()) / 1000)) }, null, 2));
  } else {
    res.writeHead(404); res.end();
  }
});
server.listen(Number(process.env.PORT) || 10000, '0.0.0.0', () => {
  console.log('RTMP_PROBE_SERVER_STARTED');
  launchMediaReceiver();
  launchTunnel();
});
function stop() {
  if (stopped) return;
  stopped = true;
  status.tunnel = 'EXPIRED';
  console.log('RTMP_PROBE_EXPIRED');
  status.publicEndpoint = null;
  status.mediaReceiver = 'STOPPED';
  status.relay = 'STOPPED';
  for (const child of children) child.kill('SIGTERM');
}
setTimeout(stop, lifetimeMs).unref();
process.on('SIGTERM', () => { stop(); server.close(); });
process.on('SIGINT', () => { stop(); server.close(); });

setInterval(() => console.log('RTMP_PROBE_HEALTH ' + JSON.stringify({tunnel:status.tunnel,receiver:status.mediaReceiver,syntheticProbe:status.syntheticProbe,authRejectionProbe:status.authRejectionProbe,relay:status.relay,relayFrames:status.relayFrames,musicMode:status.musicMode,selectedMusicCount:status.selectedMusicCount,publicSmoke:status.publicSmoke,inboundBytes:status.inboundBytes,frames:status.frames,remainingSeconds:Math.max(0,Math.floor((began + lifetimeMs - Date.now())/1000))})), 20000).unref();
