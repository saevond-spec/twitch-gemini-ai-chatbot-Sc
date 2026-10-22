# Android music in Twitch broadcast — experimental implementation

Version 0.1.5-dev. Do not represent this as production-ready or real-PS5 verified.

## What is implemented
- Android document picker: user selects one local audio/* file licensed for live streams, VODs and clips. Persistent URI only. No scraping or downloading YouTube or NCS playlists.
- Background Android MediaCodec audio decoding -> 48 kHz stereo PCM; the one selected file loops and automatically starts playing when a public Twitch test begins. Local Play/Pause controls are available.
- When PS5 emits AAC-LC 48kHz stereo, live audio is decoded, music is mixed using PcmMixer, then mixed AAC 128 kbps re-encoded for Twitch. Music playing uses 70% game / 25% music; paused music leaves 100% game PCM and still encodes AAC. Compatible H264 video is relayed without re-encoding.
- No local recording or screen/microphone capture; running the network diagnostic alone does not start Twitch output.
- Optional bot commands: set identical 32+ character ENCODER_BRIDGE_TOKEN in the Twitch bot's server environment and through the Android token input. Otherwise !play on the bot cannot control the Android mix. Token is encrypted on Android; do not share in chat.
- This is ONE looping local track; station and skip merely restart that track. True auto-changing licensed club/dubstep playlists remain unfinished.

## Verify on real hardware
1. Phone and PS5 on same home non-guest Wi-Fi. Android must display its own phone Wi-Fi IPv4; NextDNS rewrite destination must match phone address, not PS5 address.
2. Choose one authorized local music file from the Android picker.
3. Start network diagnostic only. Start a disposable PS5 Twitch broadcast and verify that both video and audio RTMP packet counters increase. If no real packets arrive, stop and investigate NextDNS and protocol; never assume IP entry alone redirects gameplay.
4. Stop the diagnostic. Enter the Twitch stream key only into Android's encrypted secret field, not chat.
5. Start the explicit public Twitch test, wait until media listener is ready, then start another PS5 Twitch broadcast. Confirm nonzero mixed AAC output counters and actual playable video/music from an INDEPENDENT Twitch viewer. Server publish acknowledgement does not prove this.
6. Verify music Play/Pause without muting game audio, background operation, thermal behavior and safe stop on network interruptions.
7. Restore PS5 DNS to its previous automatic/custom settings and remove NextDNS rewrites if direct broadcasting fails.

## Unverified and limitations
- Actual PS5-to-phone RTMP redirect is unverified on the user's console; DNS rewrites cannot redirect RTMPS/TLS on 443.
- Android MediaCodec compatibility and sustained thermals on Motorola 4 GB Android must be checked on-device.
- Song catalog/station switching, YouTube and Kick simultaneous delivery, copyright/licensing proof, and real Twitch viewer audio/video still require completion.
