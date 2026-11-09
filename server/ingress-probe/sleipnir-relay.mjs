import { timingSafeEqual } from 'node:crypto';

export const SLEIPNIR_RTMP_SERVER = 'rtmps://ingest.sleipnir.tv:1936/live';

export function relayConfiguration(env = process.env) {
  const token = env.OBS_INGEST_PUBLISH_TOKEN || '';
  const key = env.OBS_SLEIPNIR_STREAM_KEY || '';
  const enabled = env.OBS_SLEIPNIR_RELAY_ENABLED === 'true';
  if (!enabled) return { ready: false, reason: 'RELAY_DISABLED' };
  if (token.length < 32 || !/^[a-zA-Z0-9_-]+$/.test(token)) return { ready: false, reason: 'PUBLISH_TOKEN_NOT_CONFIGURED' };
  if (!key || key.length > 512 || /[\s\x00-\x1f\x7f]/.test(key)) return { ready: false, reason: 'SLEIPNIR_KEY_NOT_CONFIGURED' };
  return { ready: true, publishToken: token, streamKey: key };
}
export function authorizePublisher(body, env = process.env) {
  const config = relayConfiguration(env);
  if (!config.ready || typeof body !== 'string' || Buffer.byteLength(body) > 4096) return false;
  let form;
  try { form = new URLSearchParams(body); } catch { return false; }
  if (form.get('app') !== 'secure' || form.getAll('name').length !== 1) return false;
  const candidate = form.get('name') || '';
  const expected = config.publishToken;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a,b);
}
export function buildRelayArgs(env = process.env) {
  const config = relayConfiguration(env);
  if (!config.ready) throw Error(config.reason);
  const input = 'rtmp://127.0.0.1:1935/secure/' + config.publishToken;
  const output = SLEIPNIR_RTMP_SERVER + '/' + encodeURIComponent(config.streamKey);
  // Never echo these args or child stderr: the output URL contains a stream key.
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1',
    '-i', input, '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'copy', '-c:a', 'aac', '-ar', '48000', '-b:a', '128k',
    '-f', 'flv', output
  ];
}
