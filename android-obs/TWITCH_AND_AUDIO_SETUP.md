# Platform setup, reconnect, and audio

The encoder is experimental. A stream key being saved does not prove that a platform accepts the feed, and a publish acknowledgement does not prove viewers can watch it. Test each destination with an independent viewer.

## Configure outputs

1. In the app, check the platforms you want to use. Twitch uses the fixed secure ingest URL and your Twitch Creator Dashboard key.
2. For YouTube, paste the RTMPS ingest URL and stream key from YouTube Live Control Room. For Kick, paste the RTMPS server URL and key from the Kick Creator Dashboard.
3. Press each **Save ... server and key** button. The key is encrypted on-device with Android Keystore. Never put stream keys in a description, bot chat, or issue report.
4. Enter the stream title, game, and a few relevant search phrases, then copy the generated description. Paste it into each platform dashboard; this app does not modify channel metadata through platform APIs.
5. Enter the PS5's private IPv4 address, connect the phone and PS5 to the same Wi-Fi, and choose **START MULTISTREAM** only when you intend to publish.

## Connection recovery and quality

- Every enabled output connects and retries independently. Retry delay grows from one second to a maximum of 30 seconds while the foreground service is running.
- Each output has a small bounded queue. If it falls behind, the app drops stale packets and waits for a clean AVC keyframe before resuming. Tap **Reconnect stream outputs** to force a new platform connection.
- The notification's **health** value is based on this app's queue delay. It is not a speed test, platform health indicator, or guarantee of viewer playback.
- If the phone stops for a thermal/battery safety condition or the user presses Stop, it does not restart itself.

## Video compatibility

With **Add the @saevond live overlay to the stream** enabled, the app hardware-decodes and re-encodes the shared feed at up to 1080p while burning in the transparent cyber-samurai HUD. It is not a 4K output. Phone codec support and sustained frame rate vary; if processing fails, the app reconnects using the original video. Uncheck the option to pass H.264 through unchanged. Stats, chat, names, and alerts on the HUD are simulated demo data, not live platform activity. See the [Android encoder README](README.md) and [production release gate](PRODUCTION_RELEASE_GATE.md).

The app now offers **Stable multi-stream** (up to 720p, 4.5 Mbps video) and **High quality** (up to 1080p, 8 Mbps video) overlay profiles. With 128 kbps AAC, aggregate WAN payload is `N × (video bitrate + 0.128 Mbps)` for N selected outputs. The conservative planning target is twice that aggregate: for three outputs, over **27.8 Mbps** with Stable or **48.8 Mbps** with High. This is total sustained upload, not a per-platform amount, and is not a speed measurement. The single shared High encode stays within Kick's listed 8 Mbps video maximum but is below YouTube's 17 Mbps H.264 recommendation for 1080p60; separate encoders would be needed to meet different platform targets simultaneously. The app does not output 4K. Use output health and skipped-packet counters during a real test. No code can guarantee zero end-to-end delay because Wi-Fi, internet routing, platform ingest, and viewer buffering are outside the app's control.

## Audio

- Game and music gain sliders operate in the in-memory AAC mixer; music must be licensed for live broadcasts and VODs.
- The curated NCS catalog contains 100 tracks across Club / House, Dubstep / Bass, and Pop / Trap. Select tracks in the app, then use Shuffle and Automatically play next song for a no-repeat pass through the chosen tracks. The playlist duration depends on actual song lengths; use a larger local licensed library if you need six full hours without a repeat.
- NCS tracks include copyable stream and per-track credits. Add the required credit to each applicable stream description and check current platform-specific terms before multistreaming.
- Drake and Taylor Swift master recordings are not free-use catalog tracks. Add local audio only when you have the rights for live streams and VODs on each destination.
- The music mixer accepts AAC-LC 48 kHz stereo from the source. Other game audio formats are rejected rather than silently treated as compatible.
