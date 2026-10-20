# SweatyClanker OBS Lite — Background Multistream (development)

**Canonical requirements (October 20, 2026):** Android control app that operates as a user-started background **network streaming service**. PS5 game media must enter via a network protocol. The app is intended to mix original game audio with separately licensed music and distribute a live-only feed to **Twitch, YouTube, and Kick simultaneously**.

## Explicitly excluded
- No screen capture, MediaProjection, mirroring, Android AudioRecord, microphone or camera capture.
- No gameplay recording, VOD recording, screen recording, clips, or file archival by this app.
- No need to keep an activity/browser/media-player visible to broadcast.
- No false claim that PS5 native broadcasting can be redirected to the app by a chat command alone.

## Current code, as of this branch
- The app manifest has **no capture or recording permission** and declares just the user-started `connectedDevice` foreground service for the PS5 LAN diagnostic.
- `MainActivity` now starts/stops only an authorized PS5 IPv4 LAN diagnostic and shows device safety status; it never requests screen-capture permission.
- `Ps5LanService` accepts one private-LAN source, counts RTMP H.264/AAC *packet types* and discards payloads. It is **not** a working video/audio relay.
- Music decoding, mixing primitives, and an authenticated bot command poller are development components not yet wired to an end-to-end network streaming pipeline.
- Twitch, YouTube and Kick output delivery is **not implemented or enabled**. There is no real multistream yet.

## Proposed live-only media path

```text
PS5 broadcast source (authorized network H.264 + AAC, if accessible)
       ↓ private Wi-Fi RTMP input on Android
       ↓ verify timestamps, video/audio formats and sustained link
       ├── H.264 pass-through, if compatible
       └── AAC decode → licensed music PCM mix → AAC encode
       ↓ bounded live multiplexing (RAM only, no recording)
       ├── Twitch RTMPS
       ├── YouTube RTMPS
       └── Kick RTMPS
```

All three outputs need separate connection state and retry limits. Credentials must be encrypted with Android Keystore, never printed or committed. If PS5 emits RTMPS, **DNS redirection alone cannot intercept it**. Do not change DNS/router configuration until an independently verified legitimate input path exists.

## Android background behavior

User taps Start once while the app is visible. Android runs a **foreground service** with an ongoing notification so the UI can be closed or Twitch chat can be used. It is not an invisible unrestricted daemon; Android battery/thermal rules and OS policies may still stop it. Never restart a stream behind the user's back after a phone-safety STOP.

## Release gate

Not production ready, not merged, not live, and not confirmed on the owner's PS5 or Android phone. Before enabling Go Live: build and device tests, actual compatible PS5 ingest, H.264+AAC mux, secure RTMPS output to 3 services, music mix, independent listener verification on each platform, long-run thermal/bandwidth tests, start/stop safety, and stream-key handling.

PR #48 remains a draft. Keep live Twitch service and existing chat bot untouched.
