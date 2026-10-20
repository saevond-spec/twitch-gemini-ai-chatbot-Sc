# Software-only PS5 ingest research (October 20, 2026)

## Recommended route: PS5 native Twitch broadcast -> controlled RTMP receiver -> Android music mixer -> Twitch

The PS5 can independently encode native gameplay + audio through its **Broadcast to Twitch** control. This is superior to attempting to screen-capture Sony Remote Play on the Android phone:

- No second PSN Remote Play session; avoids secondary-account/controller handoff.
- Phone can present Twitch chat while its own foreground service receives and rebroadcasts PS5 RTMP.
- Source has game audio already encoded by the PS5, instead of relying on Android AudioPlaybackCapture permissions.
- No HDMI capture card or PC in the proposed final workflow.

### Evidence and constraints

- **Overlay Expert** markets an Android PS5 ingest product with a dedicated DNS server and an RTMP source. It describes free broadcasting with a watermark, and says its DNS method doesn't work with IPv6 enabled: https://overlay.expert/consoles
- Independent proof-of-concept: https://github.com/Aioros/console-streaming-server and https://github.com/ImLunaHey/playstation-rtmp
- A 2026 published proof-of-concept redirected the console's own RTMP stream after observing hostname/transport, and produced H.264/AAC through nginx-rtmp: https://blog.adafruit.com/2026/09/29/hijacking-the-ps5s-rtmp-stream/
- This method is not guaranteed to work on all PS5 firmware, networks, streaming accounts or RTMPS endpoints. **Never bypass TLS certificate validation, capture other people's streams, or weaken PS5 network security.**
- DNS changes should affect only the operator-owned PS5 when possible, and must be reversible. An arbitrary public DNS provider could observe/misroute traffic; do not trust one blindly. The receiver must bind securely and never expose Twitch keys publicly.

### Engineering target (NOT YET IMPLEMENTED)

1. Add a local **RTMP inbound server** to SweatyClanker OBS Android, listening on an unprivileged LAN port forwarded/redirected from PS5 as needed. Phone app must allow listening only on private Wi-Fi, validate allowed source LAN IP, limit connection count, chunk sizes and timeouts, and reject untrusted publish paths.
2. Parse incoming PS5 FLV/RTMP H.264 and AAC frames. Surface a live video decoder/encoder or validated bitstream passthrough path, and decode AAC to synchronized PCM.
3. Mix PS5 audio + local licensed music (existing PCM mixer) and encode AAC with separate per-source gains and a limiter. Preserve video timestamps. Rebroadcast to Twitch via authenticated RTMPS.
4. Run ingest, transcoding and the existing SweatyClanker command polling in a foreground service independently of the current Android screen. Keep Twitch chat/notifications **out** of the stream. Keep music paused if the bot bridge disconnects.
5. Build a diagnostic screen: ingress connected/disconnected, ingest audio/video detected, encoded output connected, actual audio RMS, bitrate, jitter, dropped frames and thermal load; do not confuse TCP connection with a verified viewer hearing audio.
6. Guide user through PS5-only DNS setup with known-good reversible choices. Explicitly test current IPv4/IPv6, PS5 broadcast settings and PlayStation network authorization. Never ask for or log PSN passwords.
7. Test on operator-owned PS5 and Android phone, verify on an independent Twitch viewer. Keep a fallback to normal PS5 direct Twitch broadcast with no music if the pipeline fails.

### Alternative: PS Remote Play in PiP + app-only capture

Sony explicitly supports PiP on Android:
https://remoteplay.dl.playstation.net/remoteplay/lang/en/1100003.html

Android 14 QPR2+ supports selecting a single app for MediaProjection, even in other windowing modes:
https://android-developers.googleblog.com/2024/03/enhanced-screen-sharing-capabilities-in-android-14.html

This may permit Remote Play in PiP while Twitch chat is foregrounded, **but game video/audio capture must be verified and may be blocked by PlayStation**. The present prototype captures a MediaProjection display/window, not a native RTMP input, and its privacy mode deliberately shows a black stream when Remote Play is hidden.

## What our PR #48 actually includes

- Android screen capture via MediaProjection (user authorization required).
- Captured Android audio + separately licensed local music -> PCM mix -> AAC/RTMPS.
- Secure bot command polling (play/pause/skip), Keystore storage, and debug APK CI.
- Privacy safeguard when sharing captured app content in background.

**Does not yet include:** PS5 network RTMP receiver, DNS redirect host, H.264/AAC ingest decode, guaranteed background PS5 gameplay, verified Twitch viewer audio. Do not merge this PR or advertise the software-only PS5 workflow as complete until those components are implemented and tested.

## Target 720p30 trial profile

Start with PS5 native broadcast H.264/AAC, phone RTMPS output at 1280x720, 30fps, ~3.5 Mbps video plus 160 kbps AAC. With phone on local Wi-Fi, traffic arriving from PS5 is LAN traffic and output to Twitch is WAN uplink. Do not equate these rates with encoded performance or imply all phones can handle simultaneous decode/encode.
