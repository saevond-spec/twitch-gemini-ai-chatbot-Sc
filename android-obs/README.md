# SweatyClanker OBS Lite — Android network relay (development)

This app accepts one authorized PS5 RTMP source over a private Wi-Fi network and can forward the H.264/AAC feed to selected RTMPS platforms. The stream is live-only: media is held briefly in bounded memory queues and is not recorded.

## What this build adds

- Twitch, YouTube, and Kick can be configured as separate RTMPS outputs. Each selected destination has its own queue, connection state, backoff retry loop, and health summary.
- Sleipnir can be selected as a single RTMPS output. Enter the Sleipnir ingest key from its dashboard; link Twitch, YouTube, and Kick in Sleipnir itself. When Sleipnir mode is selected, this app ignores the direct-output checkboxes and publishes only to the relay. Sleipnir's LIVE status in this app confirms only the phone-to-relay publish; downstream Twitch/YouTube/Kick connection status must be checked in Sleipnir's dashboard. A 180° whole-frame rotation is enabled by default in Sleipnir mode to correct upside-down output; it rotates the gameplay and overlay together and can be turned off with the rotation checkbox. Sleipnir's current Free page advertises 5 Mbps. The app requests hardware CBR with a 3.8 Mbps video target plus 128 kbps AAC; with a 10% transport allowance, the estimated total is 4.3208 Mbps, leaving 679.2 kbps below 5 Mbps. Android's bitrate is a target rather than a packet-level guarantee, so actual output peaks still need to be checked on the phone. When its capability report omits both CBR modes, the app probes CBR directly and stops if setup fails; it does not substitute VBR.
- In Sleipnir mode, video still enters and is encoded by the phone. The app uploads one stream from the phone to Sleipnir, which then fans out server-side. This does not make the phone a remote-only controller.
- The optional @saevond cyber-samurai overlay defaults on. It adds a transparent 1920×1080 HUD with red/cyan scanlines, particles, sword accents, session panels, and social footer, then sends one shared H.264/AAC feed to selected platforms.
- The overlay's stats, AI lines, chat preview, follower/subscriber names, and donation alerts are simulated demo data. They are marked on-screen and do not come from Twitch, YouTube, Kick, or real viewers.
- Adding the overlay requires hardware H.264 decode, GLES composition, and H.264 re-encoding up to 1080p. If codec setup or composition fails, the app reconnects outputs and falls back to the original PS5 video. Each extra platform still uses additional upload bandwidth.
- When a publisher falls behind, the app discards stale queued packets and waits for the next clean AVC keyframe before resuming. A **Reconnect stream outputs** button starts a manual reconnect; automatic reconnect remains enabled.
- The user-started service enters foreground before codec setup. Its notification refreshes queue health every three seconds and includes Open, Stop, and Reconnect controls. It reports this app's sender backlog, not platform uptime or internet latency. Android 13+ notification permission is requested before starting; if denied, the app explains that notification controls may be hidden. During public streams, a partial CPU wake lock is held for the session so media processing can continue with the screen off; it is released at teardown, and battery use/heat may increase. If Android kills the process, or the phone's Wi-Fi address changes, the next app open reports the previous session as unclosed; it never auto-restarts. For a changed Wi-Fi address, update the PS5's RTMP target before starting again.
- Platform stream keys are stored using Android Keystore encryption. YouTube and Kick server URLs are taken from the creator's dashboard and stored as ordinary app settings.
- A description helper creates a title and searchable live-stream description for the selected platforms, includes up to eight tags, and adds NCS track credits for catalog songs. It copies text to the clipboard; the platform titles/descriptions must still be pasted into each creator dashboard.
- The remote catalog now has 100 NCS releases: Club / House, Dubstep / Bass, and Pop / Trap. Use **Select all** in a genre's catalog picker to add the full genre in one tap, or choose individual tracks; the Mixed station shuffles across saved genres without repeating until its deck is exhausted. Up to 100 tracks can be saved per genre. Audio streams from NCS when played and is not saved as a music file.
- NCS use is conditional on its current creator policy and correct credit. Use **Copy NCS live-stream credit** for a stream description and **Copy selected NCS track credits for VODs** for exact song credits. Check the current terms for each destination before multistreaming. Drake and Taylor Swift commercial recordings are not included as free tracks; only add a local file when you hold the streaming/VOD rights.
- A network-only diagnostic remains available and does not broadcast.

- The full connection timeline records timestamped app actions and receiver/output status messages in this app's private storage. Open **View full connection timeline** to inspect or copy it. History begins after this build is installed; it cannot recover earlier `.6` events.

## Set up and test

1. Put the phone and PS5 on the same private Wi-Fi network. Enter the PS5's private IPv4 address in the app.
2. For direct streaming, select each platform and save its key and RTMPS URL. For Sleipnir, select **Use Sleipnir cloud relay**, leave the default secure ingest URL unless your dashboard specifies another, save the Sleipnir ingest key from its dashboard, and configure Twitch / YouTube / Kick destinations in Sleipnir. Do not send keys in chat.
3. In **Stream title**, **Game name**, and **Search phrases / tags**, enter your metadata and choose **Generate and copy stream description**. Paste the copied text into each platform's stream setup.
4. For music, choose **Mixed**, **Club**, **Dubstep / Bass**, or **Pop / Trap**, then tap **Browse remote NCS ... catalog** and select multiple tracks. Turn on **Shuffle songs** and **Automatically play next song** to avoid repeats until the selected playlist has played through. Copy the NCS stream credit into the stream description and the selected track credits into the VOD description.
5. Choose **START MULTISTREAM (public broadcast)** only when ready to publish. Outputs begin only after compatible PS5 media arrives and a video keyframe is available. The ongoing notification shows each platform's state, recent send rate, buffer delay, reconnect count, and skipped stale packets.
6. If a platform is stuck, tap **Reconnect stream outputs**. The sender waits for a clean keyframe and then establishes a fresh RTMPS session. **Stop receiver and all outputs** ends the session.
7. Use **Start PS5 network connection test** for a private packet-count diagnostic. That button never sends a public broadcast.

## Video limits

With the overlay enabled, the app decodes the PS5 H.264 feed, composites the full @saevond HUD, and hardware-encodes a shared output at up to 1080p. This is not a 4K output. Source and encoder support varies by phone, and sustained frame rate, heat, and viewer playback still need testing on the target device. Turn off **Add the @saevond live overlay to the stream** to use H.264 pass-through. Browser-only hover effects and keyboard shortcuts are not part of the video burn-in.

## Upload and latency budget

At the 1080p overlay profile, the video encoder targets 8 Mbps and the AAC mixer targets 128 kbps. Every selected platform receives its own copy, so the ideal payload rate is `destinations × (8.000 + 0.128) Mbps`. [Kick's current Go Live guidance](https://help.kick.com/en/articles/15159752-settings-and-stream-quality-on-the-kick-go-live-app) recommends keeping bitrate below half of upload speed. Applying that conservative ratio to the app's aggregate stream payload gives these planning thresholds:

| Destinations | Ideal media upload | Sustained upload target at 50% payload utilization |
| --- | ---: | ---: |
| 1 | 8.13 Mbps | over 16.3 Mbps |
| 2 | 16.26 Mbps | over 32.6 Mbps |
| 3 | 24.38 Mbps | over 48.8 Mbps |

These are planning thresholds, not a speed guarantee or a measured network test. [YouTube currently recommends 17 Mbps H.264 for 1080p60](https://support.google.com/youtube/answer/2853702?hl=en); [Kick's guide lists 6–8 Mbps for 1080p60 with an 8 Mbps maximum](https://help.kick.com/en/articles/7066931-how-to-stream-on-kick-com). This app uses one shared 8 Mbps video encode for all destinations, so it cannot simultaneously meet YouTube's 17 Mbps recommendation and Kick's 8 Mbps limit. The current profile targets Kick's upper range, not YouTube's highest recommended quality; platform-specific encoders would be needed to meet both targets. The overlay does not output 4K. [Twitch's current broadcast guidance lists 6,000 kbps](https://help.twitch.tv/s/article/broadcasting-guidelines), so validate the shared 8 Mbps profile with Twitch before using that destination.

The sender keeps at most 2.5 MB, 1.5 seconds of media, or 2 seconds of queued age per destination, whichever limit is reached first; it discards stale media and waits for a keyframe rather than letting delay grow indefinitely. The overlay input queue is capped at 12 frames (about 200 ms at 60 fps or 400 ms at 30 fps). Encoding, internet routing, ingest servers, and viewer players add delay outside those queue bounds. **Good** output health means under 300 ms queued, **Fair** is 300–899 ms, and **Poor** starts at 900 ms. For three 1080p outputs under the conservative half-upload planning rule, measure more than 48.8 Mbps sustained upload and keep every destination at Good health with no skipped packets during a real test.

The health label describes this app's output queue only. It is not a platform health check or an internet speed test. A successful RTMPS publish acknowledgement does not prove that viewers see or hear the stream.

## Verification limits

Unit and emulator tests use synthetic RTMP media and fake publishing destinations. They verify protocol handling, retry behavior, bounded queues, and metadata generation; they cannot prove stable PS5 ingest, platform acceptance, playable video, viewer audio, or multi-hour phone thermals. Test each selected platform with its creator dashboard and an independent viewer before relying on it.

No screen, microphone, or camera capture is included. No media is archived. Phone safety stop conditions still end the service and require a conscious restart.
