# SweatyClanker OBS Lite — production release gate

**Status: NOT PRODUCTION READY.** PR #48 stays draft. Owner device: Moto G Stylus XT2317DL, Android 14. Do not distribute the current debug APK as a production streaming solution.

## Hard blockers
- [ ] **End-to-end PS5 ingress:** prove PS5 emits a compatible unencrypted RTMP feed and connects to our phone without breaking PlayStation account security. DNS redirection must be reversible; custom DNS must be deployed to a real resolver and tested. Cannot redirect encrypted RTMPS with DNS alone.
- [ ] **Video and audio output:** implement RTMP-to-RTMPS relay on Android using *actual* PS5 H.264 frames/timestamps and AAC game audio, mix game audio with documented broadcast-licensed music, and confirm independent viewer can hear both. Current `Ps5LanService` **discards all RTMP media**.
- [ ] **Multistream:** implement output to Twitch/YouTube/Kick on Android (not just the separate Linux FFmpeg runner), test destination failures independently, and redact credentials from logs.
- [ ] **1080p60 proof:** measure real PS5 input and output resolution/FPS; no upscaling or false quality labels; stay within receiving platform limits.
- [ ] **Safety and sustained streaming:** on XT2317DL verify thermal shutoff, Android 14 service launch/persistence, battery policy, notification behavior, no unwanted automatic restart; run 15 min, 2 h, 8 h, and requested extended soak at real workload without unsafe heat.
- [ ] **Connectivity:** verify phone IP, PS5 IP, same Wi-Fi without client isolation, DNS hostname mapping, port 1935 and audio/video stream; handle packet corruption/disconnect and Wi-Fi handoff safely.
- [ ] **Streaming recovery:** bounded buffers, timeout/backoff, no runaway retry loops, video timestamp continuity, graceful user stop and crash recovery without exposing keys.
- [ ] **Release security:** separately signed release artifact, reproducible/versioned build, dependency review, application backup disabled, non-exported services, credentials held in Android Keystore and verified on-device, no secrets in telemetry.
- [ ] **On-device acceptance:** independent Twitch viewer test (video, game audio, mixed music), phone usable for Twitch chat throughout, beta owner sign-off.

## Current verified scope
- GitHub CI and Android debug APK builds worked on previous commits; latest workflow now includes Kotlin/JUnit tests.
- Proprietary physical phone/PS5 behavior is unknown, even with successful compilation.
- Experimental network foreground service counts RTMP packets; no end-to-end PS5 streaming path.
- Debug build is for cautious testing only, not unattended or unlimited live streaming.

## No-live-change rule
Do not alter the user's Spectrum router or PS5 DNS until a safe rollback and an actually reachable ingress route are independently confirmed. Do not merge PR #48 or deploy experimental code to the live Twitch bot as proof of production readiness.

## Safety rule
Protect the phone rather than prioritize an uninterrupted broadcast. Android thermal or battery STOP must end the receiver and outputs, require conscious re-start, and be validated on XT2317DL.
