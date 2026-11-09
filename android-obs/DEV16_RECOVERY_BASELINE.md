# OBS Lite dev.16 recovery baseline — 2026-11-09

Scope: **Android OBS Lite encoder only**. Do not modify the SweatyClanker chat bot, AmaanaYT, public/private YouTube visibility, or Sleipnir destinations. This is a test baseline, not a live deployment.

## Historical evidence to preserve
- User-supplied October 24, 2026 dev.16 session notes reported RTMPS publish acceptance twice.
- Session A: 1,701 video / 1,332 audio packets reported; mixed AAC 1,328.
- Session B: 1,523 video / 1,194 audio packets reported; mixed AAC 1,190.
- A later Android low-memory termination was reported at approximately 19:30 EDT.
- Counters and publisher acknowledgement establish that a media path existed in those sessions; they do **not** by themselves verify viewer-visible pixels/audio at every downstream destination.
- Earlier v0.1.3 was user-reported as a working baseline. Do not overwrite or claim to have reproduced its binary.
- Receiver previously referenced as 192.168.1.108:1935, which is a local LAN listener, not a public ingest URL.

## Code already present (main at branch creation)
- `android-obs/.../Ps5LanService.kt`: native LAN RTMP ingest; source packet counters; separate diagnostic/public modes; foreground service; memory-pressure warning.
- `android-obs/.../ingest/ReliableRtmpOutput.kt`: independent bounded destination queue, keyframe re-alignment, reconnect backoff, source-session reset, and acceptance-versus-playback distinction.
- `android-obs/.../OutputRouteSelector.kt`: one upstream Sleipnir destination when relay mode is enabled.
- `android-obs/.../SleipnirRelay.kt`: bitrate caps and low-load choices.
- `public/obs-web.*` and `server/web-receiver-agent.mjs`: browser dashboard plus a **separate** receiver-agent design. Current agent expects an nginx/FFmpeg host at `rtmp://127.0.0.1:1935/relay/ps5`; it is not equivalent to the Android APK receiver and has not been shown to ingest PS5 footage.

## Recovery procedure (no purchases)
1. Keep archived dev.16 and v0.1.3 binaries unmodified; compare Android source/Gradle revisions against dev.16 if original build artifact is available.
2. On Android, test LAN receiver in diagnostic mode first. Record local listener bind, RTMP publish acknowledgement, H.264/AAC config, first keyframe, video/audio packet deltas per 10 seconds, and audio mixing output.
3. In **private, explicitly approved** Sleipnir output test mode, send exactly one upstream RTMPS feed to the verified ingest endpoint. Keep existing Twitch/Kick destination settings unchanged; do not trigger public distribution without approval.
4. Record `ReliableRtmpOutput` state, video/audio packets, codec headers, reconnect count, skipped stale frames, queue age, and memory-pressure measurements at 10s intervals.
5. Run 2 min smoke, 15 min stability, then 60 min endurance only after the prior stage passes. If Android memory is constrained, compare 540p30 low-load with 720p30, one encoder at a time. Do not silently change the user's selected profile.
6. Check the actual public/private viewer result separately; accepted RTMPS alone is not a pixel/audio playback test.
7. Verify stopping, Wi-Fi changes, lost source, and network drop each produce truthful status and bounded reconnects.

## Pass criteria
- Receiver actually sees increasing PS5 video **and** audio packets and a fresh keyframe.
- Sleipnir publisher accepts media; packet throughput continues beyond the first GOP.
- No duplicate platform publishers while one-cloud-upstream mode is enabled.
- A reconnect waits for fresh codec headers/keyframe and does not forward stale pre-drop frames.
- Memory stays within device limits for the full endurance stage; no Android low-memory termination.
- Browser dashboard clearly reports separately: receiver status, encoder status, cloud publish, downstream playback (unverified until observed).

## Known blocker
The browser dashboard alone cannot bind Android's LAN RTMP port or invoke Android MediaCodec. To reuse the working APK ingest without a VPS or computer, keep a minimal Android receiver/encoder service and control/monitor it from the web app; a browser-only replacement would need a newly proven compatible media source.

## Verification state
No Android build, physical PS5 test, deployment or publishing was executed when this document was created. The tests added alongside it are static/unit safeguards and do not claim a successful end-to-end stream.
