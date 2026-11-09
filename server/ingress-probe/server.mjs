import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

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
  output: 'no recording and no outbound broadcast',
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
  for (const child of children) child.kill('SIGTERM');
}
setTimeout(stop, lifetimeMs).unref();
process.on('SIGTERM', () => { stop(); server.close(); });
process.on('SIGINT', () => { stop(); server.close(); });

setInterval(() => console.log('RTMP_PROBE_HEALTH ' + JSON.stringify({tunnel:status.tunnel,receiver:status.mediaReceiver,syntheticProbe:status.syntheticProbe,inboundBytes:status.inboundBytes,frames:status.frames,remainingSeconds:Math.max(0,Math.floor((began + lifetimeMs - Date.now())/1000))})), 20000).unref();
