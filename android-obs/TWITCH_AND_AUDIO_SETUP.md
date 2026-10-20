# Twitch setup and adjustable game/music volume (v0.1.6-dev)

Status: experimental, not PS5 production verified. Main SweatyClanker bot must remain unaffected until live ingest and viewer audio/video are confirmed.

## Twitch connection
1. From Android, open Twitch Creator Dashboard > Settings > Stream (https://dashboard.twitch.tv/settings/stream), sign in to the intended broadcaster account.
2. Copy the broadcaster's primary stream key on device. Paste into SweatyClanker's password-style Twitch field and press Save Twitch key securely. A key format check and local Keystore encryption do NOT verify Twitch authorization; publish can only be tested when compatible PS5 media actually arrives.
3. Phone's Wi-Fi IPv4 must equal the NextDNS **rewrite destination**, and PS5 IPv4 must match the app's allowed source. Keep PS5 and Android on same home LAN without AP isolation. Avoid rewriting ingest.twitch.tv HTTPS discovery or using the phone as the DNS resolver itself.
4. Press Start PS5 network connection test, then start a throwaway PS5 Twitch broadcast. Verify actual increasing H264 and AAC packet counts. No real PS5 packets => do not proceed to public RTMPS test.
5. Stop diagnostic. Only then press Public Twitch Test and start a new PS5 broadcast. Check Twitch playback from an independent viewer, with both gameplay and music clearly audible.
6. To roll back, stop public test, restore PS5 DNS to Automatic (or its prior addresses), and remove temporary NextDNS rewrites.

## Independent audio volume controls
- Two Android SeekBars apply to **game** and **music** at runtime; changes are saved for future app launches. Buttons provide music mute/unmute and reset to Game 85%, Music 20%. Both can be set to 0 independently.
- Volume is implemented *in the actual on-phone AAC mixing pipeline*, not via Android's speaker-volume button. Playing music requires selecting an authorized local audio file. The game slider requires incoming AAC-LC 48 kHz stereo compatible with MediaCodec. Incompatible incoming codec should produce an error, not a fake success.
- Mathematical fail-safe: let x = game slider/100 and y = music slider/100 (or zero while muted/paused); k = min(1, 0.98/(x+y)) for x+y>0, else 1; output = round(k x gameSample + k y musicSample). The triangle inequality guarantees |output| <= 0.98 full-scale even if full-volume tracks are perfectly phase-aligned. Mixer also saturates as a redundant last defense.
- The value 0.98 corresponds to approximately 20 log10(0.98) = -0.1755 dBFS guaranteed peak headroom, rather than a loudness normalization guarantee. This is not a broadcast LUFS measurement or true-peak oversampling limiter.
- Music !play/pause is only sent from the bot when the same private bridge token exists on phone and bot server. The bridge does not distribute audio; it only sends commands. Bot controls must not expose tokens or stream keys.

## Merge gate
- PR #48 remains draft and independent of the live Render service, pending real PS5/Android/Twitch verification. CI, unit and emulator tests exercise synthetic media, but cannot substitute for gameplay appearing on Twitch.
- Do not merge unfinished stream relay into main simply because the volume sliders compile; first verify end-to-end PS5 RTMP ingest, the output handshake, audio in Twitch playback, independent mute, 5-10 minute phone stability, and clean rollback.

Source: Twitch Stream Key FAQ https://help.twitch.tv/s/article/twitch-stream-key-faq