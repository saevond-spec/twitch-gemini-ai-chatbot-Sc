# SweatyClanker OBS for Android (experimental source tree)

Goal: PS5 Remote Play on Android -> user-consented MediaProjection screen video + permitted playback audio -> custom music mixer -> Twitch RTMPS, controlled by SweatyClanker's existing authenticated !play bridge.

## Current reality

This is an initial source scaffold, NOT a tested APK, and not ready for Twitch streaming. Initial service wires screen + Android playback capture to RTMPS through RootEncoder 2.8.1, but does **not yet** wire the PCM music mixer into the live encoder. PcmMixer.kt is a separately testable initial DSP building block. No console or Twitch verification has occurred. Existing cloud FFmpeg encoder remains separate.

**Non-negotiable capture test:** Android MediaProjection and AudioPlaybackCapture do not override other applications' video and audio capture policies; PS Remote Play may block video, audio, or both. Protected output stays protected. If PS Remote Play blocks capture, the app must display an error and must not attempt a circumvention.

To build: Android SDK (API 36), JDK 17+, Gradle with AGP 8.13.2 and Kotlin 2.2.21, download dependencies from Google's Maven and JitPack, assemble the debug APK. A Gradle wrapper is not yet committed; the current environment lacks Android SDK so build/runtime are not verified.

## Security

Never commit or screenshot a Twitch stream key. The minimal UI currently stores the full RTMPS URL in app-private preferences for development; production must replace it with Android encrypted keystore-backed storage and OAuth/ingest selection and redact exceptions. Capture permission must be user-initiated each session and stays foreground. The 2026 design must support newer MediaProjection lifecycle requirements before release.

## Acceptance tests

1. On a real Android device, capture a permitted test game/app, verify picture and internal audio.
2. Open PS Remote Play and check whether capture outputs video and nonzero/game-identifiable audio without protections being bypassed.
3. Generate synthetic gameplay and music tones; verify both in captured audio samples.
4. Add licensed music decoder and custom PCM audio source, apply PcmMixer mixed buffers before AAC encoding.
5. Poll the authenticated SweatyClanker bridge for !play/!skip and reconcile after disconnections.
6. Private Twitch test stream: verify picture + game + music using a *different viewer device*.
7. Only then request PR review/merge and Android APK rollout.
