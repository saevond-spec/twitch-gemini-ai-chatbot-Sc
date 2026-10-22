/** 1080p pass-through targets; actual output quality is governed by PS5 input. */
export const STREAM_TARGETS = Object.freeze({
  fullHd60: Object.freeze({ width: 1920, height: 1080, fps: 60, planningVideoKbps: 6000, planningAudioKbps: 160 }),
  fullHd30: Object.freeze({ width: 1920, height: 1080, fps: 30, planningVideoKbps: 4500, planningAudioKbps: 160 }),
});

/** Return a capability assessment rather than silently downscaling/upscaling the user's feed. */
export function assessPs5Input({ codec, width, height, fps, bitrateKbps }, target = STREAM_TARGETS.fullHd60) {
  if (!['h264', 'avc1'].includes(codec) || ![width, height, fps, bitrateKbps].every(Number.isFinite)) {
    return { supported: false, reason: 'A valid H.264 PS5 feed is required' };
  }
  if (width !== target.width || height !== target.height || fps < target.fps) {
    return { supported: false, reason: 'Input does not match requested native resolution and frame rate' };
  }
  if (bitrateKbps <= 0 || bitrateKbps > 8000) {
    return { supported: false, reason: 'Input bitrate is outside Kick 1080p H.264/CBR requirements; transcoding may be needed' };
  }
  return { supported: true, reason: 'Native video may be copied; game audio still requires music mix and AAC encode' };
}

/** Estimates phone -> Internet upload. Does not include PS5 LAN ingress or ISP transport overhead. */
export function estimateNativeFanout({ destinations, videoKbps = STREAM_TARGETS.fullHd60.planningVideoKbps,
  audioKbps = STREAM_TARGETS.fullHd60.planningAudioKbps, headroom = 0.30 } = {}) {
  if (![1, 2, 3].includes(destinations) || !Number.isFinite(videoKbps) ||
      videoKbps < 500 || videoKbps > 8000 || !Number.isFinite(audioKbps) ||
      audioKbps < 64 || audioKbps > 320 || !Number.isFinite(headroom) ||
      headroom < 0 || headroom >= 0.70) throw new Error('Invalid 1080p network budget');
  const outgoingMbps = destinations * (videoKbps + audioKbps) / 1000;
  return Object.freeze({
    outputs: destinations,
    outgoingMbps,
    recommendedStableUploadMbps: outgoingMbps / (1 - headroom),
    gibPerHour: outgoingMbps * 1000_000 * 3600 / (8 * 1024 ** 3),
    sessionCapHours: null, // application has no planned artificial cap; not an uptime guarantee
  });
}
