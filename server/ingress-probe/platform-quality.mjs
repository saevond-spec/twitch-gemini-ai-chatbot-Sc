// Platform ceilings are capabilities, not a claim that the current account,
// PS5 source, or shared Sleipnir ingest can produce these qualities.
export const QUALITY_TARGETS = Object.freeze({
  twitch: Object.freeze({
    mode: 'enhanced-broadcasting-only',
    width: 2560, height: 1440, fps: 60, videoKbps: 9000,
    codec: 'HEVC', requires: 'Affiliate/Partner + Enhanced Broadcasting + supported encoder',
    activeWithSharedSleipnir: false
  }),
  kick: Object.freeze({
    mode: 'direct-platform-ceiling',
    width: 1920, height: 1080, fps: 60, videoKbps: 8000,
    codec: 'H264', requires: 'Direct encoder; CBR, keyframe 2s',
    activeWithSharedSleipnir: false
  }),
  sleipnirFreeShared: Object.freeze({
    mode: 'one-shared-feed',
    width: 1920, height: 1080, fps: 60, videoKbps: 4500,
    audioKbps: 128, totalCapKbps: 5000,
    codec: 'H264', requires: 'Source 1080p60; CPU and connection verified',
    activeWithSharedSleipnir: true
  })
});

export function getActiveQualityProfile(env = process.env) {
  const selected = env.OBS_SHARED_HIGH_QUALITY_ENABLED === 'true';
  const p = QUALITY_TARGETS.sleipnirFreeShared;
  if (p.videoKbps + p.audioKbps > p.totalCapKbps) throw Error('Sleipnir free tier bitrate budget exceeded');
  return { ...p, enabled: selected };
}

export function buildQualityVideoArgs(profile, options = {}) {
  if (!profile?.enabled) return null;
  // The filter never upscales the input. Frames are not artificially doubled
  // from 30 to 60fps; fps from the sender is retained, to a maximum of 60.
  const filters = [
    'scale=w=1920:h=1080:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos',
    'fps=fps=min(source_fps\\,60):round=near'
  ];
  if (options.overlay) {
    filters.push('drawbox=x=0:y=0:w=iw:h=ih:color=0xD71D8B@0.85:t=8');
    filters.push("drawtext=text='@saevond':fontcolor=white:fontsize=28:x=24:y=24:box=1:boxcolor=black@0.55:boxborderw=8");
  }
  return [
    '-vf', filters.join(','),
    '-c:v','libx264','-preset','veryfast','-tune','zerolatency',
    '-pix_fmt','yuv420p','-profile:v','high',
    '-b:v', String(profile.videoKbps)+'k',
    '-maxrate', String(profile.videoKbps)+'k',
    '-minrate', String(profile.videoKbps)+'k',
    '-bufsize', String(profile.videoKbps * 2)+'k',
    '-x264-params', 'nal-hrd=cbr:force-cfr=0',
    '-g','120','-keyint_min','1',
    '-force_key_frames','expr:gte(t,n_forced*2)'
  ];
}
