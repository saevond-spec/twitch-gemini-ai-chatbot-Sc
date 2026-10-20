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

The app sends H.264 video through unchanged. It cannot select a resolution or bitrate, render a live overlay, or transcode. YouTube currently recommends 42 Mbps for H.264 4K at 30 fps and 50 Mbps at 60 fps. Kick's published limit is 1920×1080 and 8 Mbps. A single 4K feed therefore cannot be sent unchanged to both services. The 4K and overlay features need a later hardware-decoder/compositor/encoder implementation. See [YouTube's encoder settings](https://support.google.com/youtube/answer/2853702) and [Kick's streaming guide](https://help.kick.com/en/articles/7066931-how-to-stream-on-kick-com).

## Audio

- Game and music gain sliders operate in the in-memory AAC mixer; music must be licensed for live broadcasts and VODs.
- Remote NCS tracks include copyable stream and track credits. Add the required credit to each applicable stream description.
- The music mixer accepts AAC-LC 48 kHz stereo from the source. Other game audio formats are rejected rather than silently treated as compatible.
