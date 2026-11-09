import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const began = Date.now();
const lifetimeMs = 12 * 60 * 1000;
const limitBytes = 0; // No recording; FFmpeg discards decoded media.
const status = {
  mode: 'diagnostic_only',
  price: '$0 free tunnel (subject to provider limits)',
  startedAt: new Date(began).toISOString(),
  expiresAt: new Date(began + lifetimeMs).toISOString(),
  publicEndpoint: null,
  tunnel: 'STARTING',
  mediaReceiver: 'STARTING',
  frames: 0,
  output: 'null sink (never broadcasts to Sleipnir)',
  outputVerified: false,
  ps5Connected: false,
  notes: 'A public endpoint alone does not prove PS5 native broadcast can be redirected to this host and port.'
};
const children = new Set();
let stopped = false;
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
  status.mediaReceiver = 'LISTENING_OR_WAITING';
  // No Twitch/Kick/Sleipnir credential is present; incoming video is discarded.
  let buffer = '';
  spawnTracked('ffmpeg', [
    '-hide_banner','-nostdin','-loglevel','error','-progress','pipe:1',
    '-listen','1','-i','rtmp://127.0.0.1:1935/app',
    '-map','0:v:0?','-map','0:a:0?','-f','null','-'
  ], {
    data(chunk) {
      buffer = (buffer + chunk).slice(-4096);
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop();
      for (const line of parts) {
        if (line.startsWith('frame=')) {
          const n = Number(line.slice(6));
          if (Number.isSafeInteger(n) && n > status.frames) {
            status.frames = n;
            status.ps5Connected = false; // Media source identity not provable.
            status.mediaReceiver = 'MEDIA_RECEIVED_SOURCE_UNVERIFIED';
          }
        }
      }
    },
    error(error) { status.mediaReceiver = 'ERROR_' + safeError(error); },
    close(code) {
      if (!stopped && Date.now() - began < lifetimeMs) {
        status.mediaReceiver = 'RESTARTING_' + String(code);
        setTimeout(launchMediaReceiver, 3000);
      }
    }
  });
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
  if (req.url === '/' || req.url === '/status' || req.url === '/healthz') {
    res.setHeader('Content-Type','application/json; charset=utf-8');
    res.writeHead(200);
    res.end(JSON.stringify({ ...status, remainingSeconds: Math.max(0, Math.floor((began + lifetimeMs - Date.now()) / 1000)) }, null, 2));
  } else {
    res.writeHead(404); res.end();
  }
});
server.listen(Number(process.env.PORT) || 10000, '0.0.0.0', () => {
  launchMediaReceiver();
  launchTunnel();
});
function stop() {
  if (stopped) return;
  stopped = true;
  status.tunnel = 'EXPIRED';
  status.publicEndpoint = null;
  status.mediaReceiver = 'STOPPED';
  for (const child of children) child.kill('SIGTERM');
}
setTimeout(stop, lifetimeMs).unref();
process.on('SIGTERM', () => { stop(); server.close(); });
process.on('SIGINT', () => { stop(); server.close(); });
