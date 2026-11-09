import { timingSafeEqual } from 'node:crypto';
import { getActiveQualityProfile, buildQualityVideoArgs } from './platform-quality.mjs';

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
export function buildRelayArgs(env = process.env, options = {}) {
  const config = relayConfiguration(env);
  if (!config.ready) throw Error(config.reason);
  const input = 'rtmp://127.0.0.1:1935/secure/' + config.publishToken;
  const output = SLEIPNIR_RTMP_SERVER + '/' + encodeURIComponent(config.streamKey);
  // Never echo these args or child stderr: the output URL contains a stream key.
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1', '-i', input];
  const music = options.music;
  if (options.syntheticTestTone === true) {
    // This is an original synthesized 440Hz signal, never a catalog track.
    // Used only with the separate, explicitly enabled short public test.
    args.push('-f','lavfi','-i','sine=frequency=440:sample_rate=48000');
    args.push('-filter_complex',
      '[0:a:0]volume=0.85[game];' +
      '[1:a:0]aresample=48000,volume=0.22[music];' +
      '[game][music]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[outa]',
      '-map','0:v:0','-map','[outa]');
  } else if (music?.playlistPath && music.volume > 0) {
    // FFconcat plays selected audio URLs in order. Loop the playlist only
    // when auto-next was enabled; game audio remains the primary input.
    // The playlist already repeats selected tracks; concat -stream_loop is unreliable.
    args.push('-f','concat','-safe','0',
      '-protocol_whitelist','file,https,tls,tcp,crypto,http',
      '-i',music.playlistPath);
    const gameGain = Math.max(0,Math.min(1,(options.gameVolume ?? 85)/100));
    const musicGain = Math.max(0,Math.min(1,music.volume/100));
    args.push('-filter_complex',
      '[0:a:0]volume=' + gameGain.toFixed(2) + '[game];' +
      '[1:a:0]aresample=48000,volume=' + musicGain.toFixed(2) + '[music];' +
      '[game][music]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[outa]',
      '-map','0:v:0','-map','[outa]');
  } else {
    args.push('-map','0:v:0','-map','0:a:0?');
  }
  const quality = getActiveQualityProfile(env, options);
  if (options.testPassthrough === true && env.OBS_PUBLIC_SMOKE_TEST === 'true' && env.OBS_1080P60_PASSTHROUGH_TEST === 'true') {
    // Diagnostic-only: preserve native source H264, avoid a second 1080p encoder.
    args.push('-c:v','copy');
  } else if (quality.enabled) {
    args.push(...buildQualityVideoArgs(quality, {overlay:options.overlay === true}));
  } else if (options.overlay === true) {
    const label='@saevond';
    args.push('-vf',"drawbox=x=0:y=0:w=iw:h=ih:color=0xD71D8B@0.85:t=8," +
      "drawtext=text='" + label + "':fontcolor=white:fontsize=28:x=24:y=24:box=1:boxcolor=black@0.55:boxborderw=8",
      '-c:v','libx264','-preset','veryfast','-tune','zerolatency','-pix_fmt','yuv420p');
  } else args.push('-c:v','copy');
  args.push('-c:a','aac','-ar','48000','-b:a','128k','-f','flv',output);
  return args;
}
