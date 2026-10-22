/** PS5 H264 pass-through and mixed AAC output; the remote host runs one process per target for isolation. */
import { isAbsolute } from 'node:path';
import { isIP } from 'node:net';
const platforms = new Set(['twitch', 'youtube', 'kick']);
export function validateDestinations(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 3) throw Error('Configure one to three destinations');
  const seen = new Set();
  return input.map(entry => {
    if (!entry || !platforms.has(entry.platform) || seen.has(entry.platform)) throw Error('Invalid or duplicate platform');
    seen.add(entry.platform);
    if (typeof entry.url !== 'string' || entry.url.length > 1024 || /[|\[\]\\\r\n\0]/.test(entry.url))
      throw Error('Unsafe destination URL');
    let url;
    try { url = new URL(entry.url); } catch { throw Error('Invalid destination URL'); }
    if (url.protocol !== 'rtmps:' || !url.hostname.includes('.') || url.username || url.password || url.hash ||
        !url.pathname || url.pathname === '/' || url.hostname.endsWith('.local') ||
        url.hostname === 'localhost' || isIP(url.hostname) || url.hostname === '0.0.0.0') {
      throw Error('Must be external RTMPS ingest URL');
    }
    return { platform: entry.platform, url: entry.url };
  });
}
export function estimateWan({ destinations, videoKbps = 3500, audioKbps = 160, headroom = 0.30 }) {
  if (!Number.isInteger(destinations) || destinations < 1 || destinations > 3 || videoKbps < 500 ||
      videoKbps > 10000 || audioKbps < 64 || audioKbps > 320 || !Number.isFinite(headroom) ||
      headroom < 0 || headroom >= 0.7) throw Error('Invalid network profile');
  const outgoingMbps = destinations * (videoKbps + audioKbps) / 1000;
  return { outgoingMbps, minimumStableUploadMbps: outgoingMbps / (1 - headroom),
    gibPerHour: outgoingMbps * 1e6 * 3600 / 8 / (1024 ** 3) };
}
export function buildMultistreamArgs({ source, destinations = [], gameGain = 0.8, musicGain = 0.18,
  allowLocalTest = false, localTestOutput = '' } = {}) {
  if (typeof source !== 'string' || !(
    /^rtmp:\/\/127\.0\.0\.1:1935\/relay\/ps5$/.test(source) ||
    (allowLocalTest && isAbsolute(source) && /\.(mp4|mkv|flv)$/.test(source))
  )) throw Error('Source must be private PS5 RTMP relay');
  if (![gameGain, musicGain].every(v => Number.isFinite(v) && v >= 0 && v <= 1) ||
      gameGain + musicGain > 1) throw Error('Unsafe audio gain budget');
  const local = allowLocalTest && isAbsolute(localTestOutput) && localTestOutput.endsWith('.flv');
  if (localTestOutput && !local) throw Error('Invalid offline target');
  if (local && destinations.length) throw Error('Test file cannot combine with live targets');
  const targets = local ? [] : validateDestinations(destinations);
  const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-thread_queue_size', '128'];
  if (isAbsolute(source)) args.push('-re');
  args.push('-i', source, '-thread_queue_size', '64', '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:3',
    '-filter_complex', '[0:a:0]aresample=48000:async=1:first_pts=0,volume=' + gameGain + '[game];' +
      '[1:a:0]volume=' + musicGain + '[music];' +
      '[game][music]amix=inputs=2:duration=first:dropout_transition=0,' +
      'alimiter=limit=0.88:level=disabled[mixed]',
    '-map', '0:v:0', '-map', '[mixed]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k',
    '-ar', '48000', '-ac', '2');
  args.push('-progress', 'pipe:1', '-nostats');
  if (local) args.push('-f', 'flv', localTestOutput);
  else if (targets.length === 1) args.push('-f', 'flv', targets[0].url);
  else args.push('-f', 'tee', targets.map(t => '[f=flv:onfail=ignore]' + t.url).join('|'));
  return args;
}
