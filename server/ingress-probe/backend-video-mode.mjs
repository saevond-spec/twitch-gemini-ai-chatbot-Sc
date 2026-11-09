// Prioritize real-time delivery on the free CPU host, without disabling
// requested 1080p quality or misrepresenting a copied source's bitrate.
export function chooseVideoMode(env = {}, options = {}) {
  const requested = options.quality === '1080p60';
  const highQuality = env.OBS_SHARED_HIGH_QUALITY_ENABLED === 'true' && requested;
  const overlayRequested = options.overlay === true;
  const forceEncode = env.OBS_FORCE_VIDEO_REENCODE === 'true';
  if (options.testPassthrough === true && env.OBS_PUBLIC_SMOKE_TEST === 'true'
    && (env.OBS_1080P60_PASSTHROUGH_TEST === 'true' || env.OBS_HEAVY_MOTION_SMOKE_TEST === 'true')) {
    return {videoMode:'copy', overlayApplied:false, reason:'EXPLICIT_TEST_PASSTHROUGH', highQuality};
  }
  // Burned-in overlay must not silently become a second 1080p encoder.
  // Only the administrator can expressly opt in to its substantial CPU cost.
  if (overlayRequested && !forceEncode) {
    return {videoMode:'copy', overlayApplied:false, reason:'OVERLAY_DEFERRED_CPU_LIMIT', highQuality};
  }
  if (highQuality) {
    return {videoMode:forceEncode ? 'bounded-encode' : 'copy',
      overlayApplied:overlayRequested && forceEncode,
      reason:forceEncode ? 'ADMIN_EXPLICIT_REENCODE' : 'HIGH_QUALITY_PASSTHROUGH',highQuality};
  }
  if (overlayRequested && forceEncode) return {
    videoMode:'overlay-encode',overlayApplied:true,reason:'ADMIN_EXPLICIT_REENCODE',highQuality:false
  };
  return {videoMode:'copy',overlayApplied:false,reason:'SOURCE_PASSTHROUGH',highQuality:false};
}
