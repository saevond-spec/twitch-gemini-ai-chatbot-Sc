# SweatyClanker OBS Lite — Android network relay (development)

This app accepts one authorized PS5 RTMP source over a private Wi-Fi network and can forward the H.264/AAC feed to selected RTMPS platforms. The stream is live-only: media is held briefly in bounded memory queues and is not recorded.

## What this build adds

- Twitch, YouTube, and Kick can be configured as separate RTMPS outputs. Each selected destination has its own queue, connection state, backoff retry loop, and health summary. Saving a YouTube or Kick key selects that destination for the next public stream; it still requires a valid RTMPS URL and an explicit **GO LIVE TO SELECTED PLATFORMS** tap.
- YouTube and Kick RTMPS URLs save automatically as soon as a complete valid secure URL is pasted or entered. The nearby cyan confirmation shows they are stored on the phone; a visible confirm/save button is available too. The setup screen now uses a dark red/cyan SAEVOND theme with clear section headings and brings PS5, destinations, reconnect, and diagnostic controls forward.
- The optional @saevond cyber-samurai overlay defaults on. It adds a transparent 1920×1080 HUD with red/cyan scanlines, particles, sword accents, session panels, and social footer, then sends one shared H.264/AAC feed to selected platforms.
- The overlay's stats, AI lines, chat preview, follower/subscriber names, and donation alerts are simulated demo data. They are marked on-screen and do not come from Twitch, YouTube, Kick, or real viewers.
- Adding the overlay requires hardware H.264 decode, GLES composition, and H.264 re-encoding up to 1080p. If codec setup or composition fails, the app reconnects outputs and falls back to the original PS5 video. Each extra platform still uses additional upload bandwidth.
- When a publisher falls behind, the app discards stale queued packets and waits for the next clean AVC keyframe before resuming. A **Reconnect stream outputs** button starts a manual reconnect; automatic reconnect remains enabled.
- The notification refreshes queue health every three seconds. It reports this app's sender backlog, not platform uptime or internet latency.
- Remote connection diagnostics can be enabled in **Connection check**. During the private test or a public stream, the app sends one small summary every 30 seconds to the configured Render service: Android's validated-internet flag and connection type, PS5 packet counters, per-platform send rate and queue, reconnect/drop counts, and allowlisted error categories. The app keeps no diagnostic history or latest status line on the phone; reports and the temporary upload credential stay in memory only. Disable the checkbox at any time to stop sending.
- Remote reports require the same `ENCODER_BRIDGE_TOKEN` in Render and in **Save private !play bridge token**. Use **Generate and copy secure bridge token for Render**, paste it into Render's environment variables, then save that same token in the app. Render receives no stream keys, RTMPS URLs, phone/PS5 IP address, Wi-Fi name, chat, viewer count, music, or media. The phone still keeps the required streaming settings and encrypted platform keys so it can publish directly to each RTMPS destination.
- Reports go to Render runtime logs, not a database or persistent disk. On the current free Render setup, the service may sleep and delay or miss a report; log retention in the current workspace is up to seven days. These reports show phone-side connection and sender health, not viewer traffic. Real per-platform viewer counts need separate platform authorization and are not connected in this build.
- Platform stream keys are stored using Android Keystore encryption. Buttons open YouTube Studio and Kick's Creator Dashboard at the stream setup pages; copy the server URL and key into the app manually. Android does not scrape or import secrets from those webpages. YouTube and Kick server URLs are stored as ordinary app settings.
- A description helper creates a title and searchable live-stream description for the selected platforms, includes up to eight tags, and adds NCS track credits for catalog songs. It copies text to the clipboard; the platform titles/descriptions must still be pasted into each creator dashboard.
- The remote catalog now has 100 NCS releases: Club / House, Dubstep / Bass, and Pop / Trap. Select several or all tracks from each catalog; the Mixed station shuffles across the saved genres and will not repeat a track until its current shuffle deck is exhausted. It supports up to 100 saved tracks per genre. Audio streams from NCS when played and is not saved as a music file.
- NCS use is conditional on its current creator policy and correct credit. Use **Copy NCS live-stream credit** for a stream description and **Copy selected NCS track credits for VODs** for exact song credits. Check the current terms for each destination before multistreaming. Drake and Taylor Swift commercial recordings are not included as free tracks; only add a local file when you hold the streaming/VOD rights.
- A network-only diagnostic remains available and does not broadcast.

## Set up and test

1. Put the phone and PS5 on the same private Wi-Fi network. Enter the PS5's private IPv4 address in the app.
2. For Twitch, use **Open Twitch Creator Dashboard**; for YouTube, use **Open YouTube Studio — Go Live / stream key**; for Kick, use **Open Kick Creator Dashboard — Stream URL & key**. Paste each YouTube/Kick RTMPS server URL; it saves automatically when valid, and the nearby cyan confirmation appears. You can also tap **Confirm / save ... URL**. Save each key separately. Saving a YouTube or Kick key selects that platform for the next public stream; the readiness row shows if a URL or key is missing. Keys stay on the device; do not send them in chat. Dashboard links do not transfer keys automatically.
3. In **Stream title**, **Game name**, and **Search phrases / tags**, enter your metadata and choose **Generate and copy stream description**. Paste the copied text into each platform's stream setup.
4. For music, choose **Mixed**, **Club**, **Dubstep / Bass**, or **Pop / Trap**, then tap **Browse remote NCS ... catalog** and select multiple tracks. Turn on **Shuffle songs** and **Automatically play next song** to avoid repeats until the selected playlist has played through. Copy the NCS stream credit into the stream description and the selected track credits into the VOD description.
5. Choose the overlay quality profile, then tap **GO LIVE TO SELECTED PLATFORMS** only when ready to publish. **PS5 ingest test only — no public stream or overlay** is diagnostic. Outputs begin only after compatible PS5 media arrives and a video keyframe is available. The on-screen status and ongoing notification show every platform's state, recent send rate, buffer delay, reconnect count, and skipped stale packets.
6. If a platform is stuck, tap **Reconnect stream outputs**. The sender waits for a clean keyframe and then establishes a fresh RTMPS session. **Stop receiver and all outputs** ends the session.
7. Use **Start PS5 network connection test** for a private packet-count diagnostic. That button never sends a public broadcast.

## Video limits

With the overlay enabled, the app decodes the PS5 H.264 feed, composites the full @saevond HUD, and hardware-encodes one shared output. **Stable multi-stream** targets up to 720p at 4.5 Mbps; **High quality** targets up to 1080p at 8 Mbps. Hardware may choose 30 fps when 60 fps is unsupported. This is not a 4K output. Source and encoder support varies by phone, and sustained frame rate, heat, and viewer playback still need testing on the target device. Turn off **Add the @saevond live overlay to the stream** to use H.264 pass-through. Pass-through keeps the original PS5 resolution and bitrate. Browser-only hover effects and keyboard shortcuts are not part of the video burn-in.

## Upload and latency budget

Every selected platform receives a full copy of the shared output. The on-screen budget uses `aggregate media bitrate = destination count × (video bitrate + 0.128 Mbps AAC)`. Applying a conservative 50% payload-utilization ceiling gives `sustained upload target = 2 × aggregate media bitrate`. This is a planning threshold, not a speed guarantee or measured network test. Kick advises lowering bitrate by 1 Mbps steps if streams stutter and supports up to 8 Mbps video, 1080p, 60 fps, H.264, CBR, and a 2-second keyframe. YouTube recommends 17 Mbps H.264 for 1080p60 and 8 Mbps for 720p60; both platforms recommend CBR and a 2-second keyframe. The app shows a live estimate for the selected profile and number of destinations.

| Destinations | Stable 720p payload | Stable 720p upload target | High 1080p payload | High 1080p upload target |
| --- | ---: | ---: | ---: | ---: |
| 1 | 4.63 Mbps | over 9.3 Mbps | 8.13 Mbps | over 16.3 Mbps |
| 2 | 9.26 Mbps | over 18.5 Mbps | 16.26 Mbps | over 32.6 Mbps |
| 3 | 13.88 Mbps | over 27.8 Mbps | 24.38 Mbps | over 48.8 Mbps |

The high profile stays at Kick's stated 8 Mbps maximum, while YouTube's recommended 1080p60 H.264 rate is higher; the single shared encoder cannot meet both targets at once. The stable profile reduces aggregate upload load and sits at Twitch's listed 720p60 bitrate and between YouTube's listed minimum and recommended 720p60 H.264 rates. If Twitch is selected with the 1080p profile, the app displays that its shared 8 Mbps rate is above Twitch's 6 Mbps 1080p60 guide. If upload or Wi-Fi airtime is constrained, lower the profile or reduce the number of destinations. [YouTube says to match quality to the connection and monitor stream health](https://support.google.com/youtube/answer/2853702?hl=en); [Kick advises reducing bitrate by 1 Mbps until stutter stops](https://help.kick.com/en/articles/7066931-how-to-stream-on-kick-com). The overlay does not output 4K.

The sender keeps at most 2.5 MB, 1.5 seconds of media, or 2 seconds of queued age per destination, whichever limit is reached first; it discards stale media and waits for a keyframe rather than letting delay grow indefinitely. The overlay input queue is capped at 12 frames (about 200 ms at 60 fps or 400 ms at 30 fps). Encoding, internet routing, ingest servers, and viewer players add delay outside those queue bounds. **Good** output health means under 300 ms queued, **Fair** is 300–899 ms, and **Poor** starts at 900 ms. For three 1080p outputs under the conservative half-upload planning rule, measure more than 48.8 Mbps sustained upload and keep every destination at Good health with no skipped packets during a real test.

The health label describes this app's output queue only. It is not a platform health check or an internet speed test. A successful RTMPS publish acknowledgement does not prove that viewers see or hear the stream.

## Verification limits

Unit and emulator tests use synthetic RTMP media and fake publishing destinations. They verify protocol handling, retry behavior, bounded queues, and metadata generation; they cannot prove stable PS5 ingest, platform acceptance, playable video, viewer audio, or multi-hour phone thermals. Test each selected platform with its creator dashboard and an independent viewer before relying on it.

No screen, microphone, or camera capture is included. No media is archived. Phone safety stop conditions still end the service and require a conscious restart.
