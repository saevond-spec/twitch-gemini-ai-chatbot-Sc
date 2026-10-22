# SweatyOBS production release gate

**Status: experimental; not production ready.** A successful APK build or synthetic test does not prove compatibility with a retail PS5 or a stable public broadcast.

## Real-device checks still required

- [ ] Verify a retail PS5 can send a compatible RTMP feed to the phone without weakening account or network security. Keep a rollback path for any network changes.
- [ ] Test Twitch, YouTube, and Kick independently with dashboards and independent viewers. Confirm one failed destination does not stall the others and retries recover after a network interruption.
- [ ] Verify PS5 game audio and selected licensed music on every destination. The music mixer expects AAC-LC 48 kHz stereo input.
- [ ] Measure source resolution, frame rate, bitrate, dropped packets, audio/video sync, and sustained phone upload. Video passes through at the PS5's source quality; each destination needs upload capacity for a copy of the feed plus overhead.
- [ ] Verify thermal safety, foreground-service behavior, notification controls, and battery behavior during a sustained stream on the target phone.
- [ ] Test PS5 source disconnect/reconnect, each output's automatic retry, manual reconnect, bounded queues, stale-packet dropping, keyframe resumption, and clean Stop.
- [ ] Create a separately signed release APK and verify Android Keystore behavior and secret redaction on the release build.
- [ ] Ask independent viewers to confirm playable video and audio on every selected destination.

## Current implementation

- Each selected RTMPS destination has an independent publisher worker, bounded media queue, automatic retry loop, and manual reconnect control.
- A publisher resumes from cached AVC/AAC headers and a fresh video keyframe. Stale media is discarded when the output falls behind.
- Video is passed through from the PS5. The overlay, live-chat burn-in, compositor, and video re-encode path have been removed to reduce processing load.
- Platform stream keys are stored in Android Keystore. Metadata generation copies text to the clipboard; it does not update creator dashboards through platform APIs.
- Media is not recorded. Phone-safety stops end streaming and require the user to start again.
- The Android project builds independently from SweatyClanker's Node source. Remote admin unlock, optional diagnostics, and optional `!play` music control remain HTTPS API integrations; no chatbot code is packaged in the APK.

Automated tests use synthetic RTMP media and fake destinations. They validate software behavior only and must not start a public broadcast.
