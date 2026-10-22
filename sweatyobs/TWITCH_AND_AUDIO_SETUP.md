# Platform setup, reconnect, and audio

The encoder is experimental. Saving a stream key does not prove a platform accepts the feed, and a publish acknowledgement does not prove viewers can watch it. Test each destination with an independent viewer before relying on it.

## Configure outputs

1. Check the platforms you want to use. Twitch uses its built-in secure ingest URL and your Twitch Creator Dashboard key.
2. For YouTube, use the RTMPS ingest URL and key shown in YouTube Live Control Room. For Kick, use the RTMPS server URL and key from the Kick Creator Dashboard. The app pre-fills the usual secure YouTube and Kick URLs.
3. Save each server URL and key separately. The keys are masked at entry and encrypted on-device with Android Keystore. Never put stream keys in a description, bot chat, or issue report.
4. Enter the stream title, game, and relevant search phrases, then copy the generated description into each platform dashboard. This app does not change channel metadata through platform APIs.
5. Enter the PS5's private IPv4 address and connect the phone and PS5 to the same Wi-Fi. The network test does not publish. Tap **GO LIVE TO SELECTED PLATFORMS** only when ready to broadcast.

## Connection recovery

- Each enabled output connects and retries independently, with retry delay growing from one second to a maximum of 30 seconds while the foreground service runs.
- Each output has a bounded queue. When it falls behind, stale packets are dropped and it waits for a clean AVC keyframe before resuming. Tap **Reconnect stream outputs** for a manual reconnect.
- The notification's health value describes this app's queue delay. It is not a speed test, a platform health indicator, or proof of viewer playback.
- A phone safety stop or user Stop ends the service and requires a manual restart.

## Video and audio

The encoder passes H.264 video through from the PS5. It has no overlay, video compositor, or video re-encode. Output resolution and bitrate follow the PS5 source. Each additional platform uses additional upload bandwidth. Real-device upload, heat, and platform playback still need testing.

- Game and music gain sliders operate in the in-memory AAC mixer. Music must be licensed for live broadcasts and VODs.
- The curated NCS catalog contains 100 tracks across Club / House, Dubstep / Bass, and Pop / Trap. Shuffle and auto-next can play the selected tracks without immediate repeats; six hours without repeats depends on actual track lengths.
- Add the required NCS credit to each applicable stream description and check current platform terms before multistreaming.
- Drake and Taylor Swift master recordings are not free-use catalog tracks. Add local audio only when you have the rights for live streams and VODs on each destination.
- The music mixer accepts AAC-LC 48 kHz stereo from the source. Unsupported game-audio formats are rejected rather than treated as compatible.
