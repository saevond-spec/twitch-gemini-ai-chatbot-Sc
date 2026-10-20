# SweatyClanker OBS Lite — production release gate

**Status: experimental; not production ready.** PRs #48 and #49 are merged, but the merged code is not evidence of retail PS5 compatibility or sustained, viewable broadcasts. Do not treat a passing APK build as an on-device acceptance test.

## Remaining gates

- [ ] **Real PS5 ingest:** verify the console can send a compatible unencrypted RTMP feed to the phone without account or network security changes. Do not change router or PS5 DNS without a safe rollback and a confirmed legitimate input route.
- [ ] **Each streaming destination:** verify Twitch, YouTube, and Kick separately with platform dashboards and independent viewers. Test that one failed destination does not stall the others and that reconnects recover after Wi-Fi/internet interruption.
- [ ] **Audio:** verify PS5 game AAC plus selected licensed music on every destination. The music mixer requires AAC-LC 48 kHz stereo input.
- [ ] **Quality and upload budget:** measure actual resolution, frame rate, bitrate, dropped packets, and audio/video sync with the overlay enabled and with pass-through selected. The overlay path hardware-decodes, composites, and encodes up to 1080p; 4K output is not supported or promised. For three 1080p outputs, verify more than 48.8 Mbps sustained phone upload under the conservative half-upload budget and all output queues remain under 300 ms without skipped packets during a real test. The shared 8 Mbps video profile is below YouTube's current 17 Mbps H.264 recommendation for 1080p60, though within Kick's 8 Mbps cap; separate profiles are needed to meet both targets.
- [ ] **Phone safety and sustained streaming:** on the target phone, verify thermal stop, Android foreground-service behavior, notification controls, battery policy, and a sustained real workload. Automated emulator tests do not cover multi-hour thermals.
- [ ] **Recovery:** test source disconnect/reconnect, each output's exponential retry, manual output reconnect, bounded memory use, stale-frame dropping, and clean user stop.
- [ ] **Release security:** create a separately signed release APK, review dependencies and permissions, confirm stream keys remain in Android Keystore, and verify no credentials appear in logs or app status.
- [ ] **User acceptance:** an independent viewer confirms playable video, game audio, selected music, metadata, and stability on every platform.

## Current implementation

- Each selected RTMPS destination has a separate background publisher worker, a bounded in-memory media queue, an automatic retry loop with a 30-second maximum delay, and a manual reconnect control.
- A publisher resumes only from cached AVC/AAC headers plus a new video keyframe. Old frames are discarded when the sender falls behind. Status reports queue delay and send rate, not actual internet throughput or platform-side health.
- The optional @saevond overlay adds a full-screen transparent cyber-samurai HUD with animated panels and clearly labeled simulated stats/chat/alerts, then hardware-encodes the shared video output up to 1080p. Device support and sustained performance remain unverified on the target Moto G Stylus. The pass-through option forwards the original H.264 feed.
- Platform stream keys are stored in Android Keystore. Stream metadata generation copies text to the clipboard and does not update creator dashboards through platform APIs.
- Media is not recorded. Phone-safety stops end streaming and require the user to start again.

## Safety and test scope

CI tests use synthetic RTMP and fake output publishers. They validate software paths and cannot prove live platform acceptance or a real PS5 broadcast. Keep the Twitch bot and Render deployment unchanged while validating this Android app. Do not start a public broadcast as part of automated testing.
