# Maximum available platform quality — not one universal 4K stream

Current production architecture: one cloud RTMP receiver -> one RTMPS feed to Sleipnir Free -> Twitch and Kick. Sleipnir Free is **1080p, 5 Mbps maximum per input**. The shared feed must meet both platforms' requirements. The dedicated cloud receiver cannot send two different resolutions to Sleipnir and have Sleipnir create separate output encodes.

## Coded ceilings
- Shared Sleipnir Free: up to **1920x1080 / source 60 fps**, **4500 kbps video + 128 kbps AAC**, H.264 CBR, 2-second forced keyframe intervals; subject to CPU/network/source limits. Selected via OBS dashboard profile `1080p60` and independent secret `OBS_SHARED_HIGH_QUALITY_ENABLED=true` on isolated receiver. By default it is OFF to prevent surprise CPU overload; saving profile alone does not guarantee quality.
- Kick's independent maximum: **1920x1080 60fps, 8000 kbps H.264 CBR**. Reaching this full bitrate requires an independent authorized ingest/encoder path, NOT the Sleipnir Free 5 Mbps relay.
- Twitch 1440p: **2560x1440 60fps at up to 9000 kbps with Enhanced Broadcasting**, Affiliate/Partner eligibility, HEVC supported encoder; cannot be achieved by an ordinary single RTMP feed from this free relay. Do not silently attempt or claim it.
- 4K: not configured or promised for either destination.

The high quality FFmpeg filter preserves aspect ratio and does not upscale lower-resolution source frames; it also will not magically convert genuine 30fps PS5 input into true 60fps. Overlay requires re-encoding. The music mixer can be combined with the constrained shared encoder. Two destination keys and Twitch Enhanced Broadcasting are not accessible via Sleipnir read-only controls.

## Deployment gate
1. Set the dashboard to 1080p60 and save. The receiver obtains this from the authenticated music/profile sync, even if music is disabled.
2. Verify at least 1080p60 input from an approved source, CPU capacity, output bitrate and platform viewer playback.
3. Enable `OBS_SHARED_HIGH_QUALITY_ENABLED=true` on the isolated Render receiver to request the 1080p60 bounded encode. Do not enable before a controlled test on this free instance.
4. If frames stall or video cannot sustain real time, disable the gate and fall back to passthrough/720p30. Actual PS5 native routing is still unverified.

Official platform source: https://help.kick.com/en/articles/7066931-how-to-stream-on-kick-com
https://help.twitch.tv/s/article/enhanced-broadcasting?language=en_US
https://sleipnir.tv/
