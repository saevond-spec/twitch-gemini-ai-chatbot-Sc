# Moto G Stylus XT2317DL — device acceptance profile (Oct 2026)

## Confirmed model and hardware
- Motorola Moto G Stylus **2023 4G**, model XT2317DL (TracFone variant). Lenovo repair guide identifies `XT2317DL, MB, TF, 4+64`.
- Helio G85, **4 GiB physical RAM**, **64 GB eMMC storage**, **Wi-Fi 5**, 720p phone display, nominal 5,000 mAh battery; shipped with Android 13.
- MediaTek officially lists H.264/H.265 hardware *encode and decode* up to **1080p60** on this chipset. This is a SoC capability ceiling, **not** a validated sustained simultaneous ingest+mix+RTMPS benchmark.
- Hardware manufacturer references:
  - https://www.mediatek.com/products/smartphones/mediatek-helio-g85
  - https://en-us.support.motorola.com/app/answers/detail/a_id/173983/
  - https://documents.cdn.ifixit.com/ZjyYxviiYBAlgvIS.pdf

## Selected architecture
1. Receive genuine PS5 H.264 RTMP on owner-operated LAN via tested DNS redirection, **if** PS5 emits compatible unencrypted RTMP. DNS alone cannot replace RTMPS or override TLS verification.
2. **Copy original 1920×1080 @ 60 fps H.264** without software video decode/re-encode, preserving actual PS5 bitstream resolution; if source is 720p or 30 fps, never label output 1080p60.
3. Decode only PS5 AAC game audio → mix licensed club/dubstep PCM at safe gain → encode one AAC stream.
4. Fan out a single compressed H.264/AAC feed to up to three RTMPS destinations. The same video stream is transmitted three times, requiring proportionally more WAN upload.
5. Android foreground service with persistent notification and manual user start; **not** mediaProjection screen capture. Choose service type according to real network use per Android policy, not just to evade Android 15 timeouts. Chat UI can remain in browser.
6. **No artificial session cap** in software. No guarantee against phone thermal shutdown, out-of-memory kills, battery/power issues, connection drops, platform disconnects, or home Wi-Fi outage.
7. Do not store stream keys in plaintext HTML, GitHub repos, screenshots, or logs. User must approve any live transmission.

## Acceptance matrix before claiming compatibility
- [ ] App builds, installs and foreground service runs on actual XT2317DL OS version.
- [ ] Hardware MediaCodec codec capability probe passes; skip video codecs entirely for native pass-through path.
- [ ] PS5 sends proper H.264/AAC via RTMP to phone using custom PS5 DNS; correct local IP and port confirmed.
- [ ] 1080p60 stream verified at receiver and independently verified at Twitch output (not upscaled).
- [ ] Game audio/music audible together to independent viewer after `!play`.
- [ ] 2-hour soak while browsing Twitch chat: process remains active, frames/audio timestamp monotonic, dropped frames within tested threshold, CPU/temperature/memory recorded.
- [ ] 8-hour extended soak on wired charging in a ventilated position; thermal throttling and battery charging behavior validated.
- [ ] 24-hour soak if user desires all-day sessions, with intentional network disconnect/reconnect and app notification recovery.
- [ ] Wi-Fi upload test at intended outputs' aggregate bitrate + 30% headroom.
- [ ] Security checks: only authorized PS5 and destinations, no open RTMP listener or public DNS service, keys redacted.

## Bandwidth planning, not measured speed
If PS5 outputs 6 Mbps H.264 + 160 kbps audio:
- One stream: 6.16 Mbps sustained upload, >8.8 Mbps with 30% headroom.
- Three streams: 18.48 Mbps sustained upload, >26.4 Mbps with headroom.
If native PS5 output is 8 Mbps video + 160 kbps audio:
- Three streams need 24.48 Mbps raw upload, >35 Mbps with headroom.

## Caveat
The current PR's Android capture app is a MediaProjection prototype; it is **not** already an independent live PS5 RTMP receiver-to-Twitch bridge. Nor is the native Android code currently three-output production software. Do not merge/deploy or instruct the user to change PS5 DNS until a real on-device test succeeds.
