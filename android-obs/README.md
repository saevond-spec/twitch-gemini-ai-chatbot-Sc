# SweatyClanker OBS Android — Development build

Goal: PS5 gameplay on Android + free streaming app + local licensed music controlled by SweatyClanker's `!play`, audible inside a Twitch RTMPS stream.

## Implemented in source

- Foreground Android screen capture with user-initiated MediaProjection consent
- Android AudioPlaybackCapture (respects source-app capture policies) and H.264/AAC RTMPS output using RootEncoder 2.8.1
- Stereo 48kHz PCM game/music mixing, bounded playback source, game and music RMS measurements in mixer
- User-selected local audio file (decoded by MediaCodec), up to 5 minutes, loop playback
- Authenticated HTTPS polling of SweatyClanker command bridge for `!play`, `!music pause`, `!skip`
- Android Keystore encryption for stream destination and bridge token
- GitHub Actions APK build workflow at `.github/workflows/android-obs.yml`

## Essential limitations

- **Not yet tested on a physical Android device or PS5.** PS Remote Play may restrict MediaProjection screenshot/video and audio playback capture. Android cannot override those protections. No guaranteed solution exists from Android capture alone if Sony blocks it.
- **Debug prototype, not production:** only one locally selected music track; station switching currently restarts the same track, not distinct dubstep/club playlists; output audio meters are computed internally but not displayed in UI; no automatic fallback if captured gameplay audio is silent.
- Build must succeed on GitHub Actions before an APK is considered available. Successful APK compilation alone cannot verify viewer audio.
- For now, you must supply your RTMPS ingest endpoint/stream key manually. Keep it secret, never post it in chat/screenshots or public code. The bot command bridge needs the same 32+ character `ENCODER_BRIDGE_TOKEN` in its hosting environment and in the app, plus the bot's HTTPS base URL.
- Licensed local music means you already hold permission for live broadcasts and VODs. Being free to listen is not equivalent to rights for Twitch distribution.
- Starting music while ScreenService is streaming updates the live AAC audio mix, not just a browser page. This only works if media capture and RTMPS transmission are running and accepted.

## Device acceptance procedure

1. Obtain the debug APK from the Actions run **after the build passes**, not an unverified external APK.
2. Test with an ordinary capturable Android game/app first. Confirm the Twitch stream has video and native game audio using a second device.
3. Select a licensed local music file; configure the bot HTTPS origin and matching bridge token; grant screen capture; use `!play` in Twitch chat. A second viewer device must hear **both game sound and music**.
4. Repeat using PS Remote Play. If Remote Play video becomes black or internal audio is silence, do not label the product PS5-compatible. Diagnose source-app restrictions without attempting to bypass Android/Sony capture protections.
5. Check thermal throttling, battery use, reconnection, RTMPS stream ingest, VOD audio, chat latency, and audio clipping before production use.

Project branch: `feat/stream-encoder-mvp`, draft PR #48. Do not merge or deploy to live Twitch until device tests pass.

## Background Twitch chat / privacy mode

The Android foreground capture/encoder service continues when the app UI is no longer visible. A **Chat Safe Mode** button replaces the encoded phone screen with black video and silences captured-app sound while keeping licensed local music and authenticated `!play` available. On Android 14+ when an individual shared app is hidden, the MediaProjection visibility callback also engages this privacy guard. **This does not keep PS5 gameplay visible or audible** while the user chats: true PS5 gameplay needs a separate capture feed not dependent on the phone's screen, or a second device. There is no PlayStation login bypass. This code is experimental until tested on the phone and Twitch ingest.
