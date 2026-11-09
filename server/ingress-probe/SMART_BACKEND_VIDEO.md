# CPU-safe OBS video backend

This is the existing web backend's isolated cloud receiver (not a separate hosting provider).

When `OBS_SHARED_HIGH_QUALITY_ENABLED=true` and the saved dashboard profile requests `1080p60`, the backend now defaults to H.264 `-c:v copy`. This avoids re-encoding heavy gameplay on Render's limited free CPU. Original source dimensions, frame timing, and video bitrate are inherited; passthrough **does not** generate higher resolution or frame rate, nor limit a source that exceeds Sleipnir Free's 5 Mbps cap.

Music mixing continues with FFmpeg's audio filter graph and AAC audio encoding independently of video copying. An ordinary @saevond burned-in overlay cannot be preserved through video copy: the backend explicitly sets `overlayApplied=false` and `videoModeReason=OVERLAY_DEFERRED_CPU_LIMIT` instead of implying it rendered.

Only a trusted administrator who explicitly sets `OBS_FORCE_VIDEO_REENCODE=true` on the receiver may opt into costly CPU video encoding and burned-in overlay. This mode has failed high-motion 1080p60 stress tests on the free host and is **not** recommended for production. It defaults to off.

A 1080p60 heavy-motion synthetic source previously achieved ~14 fps on this host, whereas the video-copy relay to Sleipnir/Twitch/Kick continued reporting live. Video passthrough with *pre-encoded real gameplay* has not been verified using a PS5. Local synthetic encode tests do not prove stable live gameplay.

Normal test flags are off. Do not start a public test without a bounded run and safe shutdown.

Video diagnostics expose the effective video mode and whether the overlay was actually applied, without printing FFmpeg URLs or stream credentials.
