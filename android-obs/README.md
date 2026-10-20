# SweatyClanker OBS Lite — Android network relay (development)

This app accepts one authorized PS5 RTMP source over a private Wi-Fi network and can forward the H.264/AAC feed to selected RTMPS platforms. The stream is live-only: media is held briefly in bounded memory queues and is not recorded.

## What this build adds

- Twitch, YouTube, and Kick can be configured as separate RTMPS outputs. Each selected destination has its own queue, connection state, backoff retry loop, and health summary.
- Each additional output uses additional upload bandwidth because the app sends the same H.264/AAC feed to every selected platform.
- When a publisher falls behind, the app discards stale queued packets and waits for the next clean AVC keyframe before resuming. A **Reconnect stream outputs** button starts a manual reconnect; automatic reconnect remains enabled.
- The notification refreshes queue health every three seconds. It reports this app's sender backlog, not platform uptime or internet latency.
- Platform stream keys are stored using Android Keystore encryption. YouTube and Kick server URLs are taken from the creator's dashboard and stored as ordinary app settings.
- A description helper creates a title and searchable live-stream description for the selected platforms, includes up to eight tags, and adds NCS track credits for catalog songs. It copies text to the clipboard; the platform titles/descriptions must still be pasted into each creator dashboard.
- A network-only diagnostic remains available and does not broadcast.

## Set up and test

1. Put the phone and PS5 on the same private Wi-Fi network. Enter the PS5's private IPv4 address in the app.
2. Select each platform you want. Save the Twitch key, or paste the RTMPS server URL and stream key from the YouTube or Kick creator dashboard. Keys stay on the device; do not send them in chat.
3. In **Stream title**, **Game name**, and **Search phrases / tags**, enter your metadata and choose **Generate and copy stream description**. Paste the copied text into each platform's stream setup.
4. Choose **START MULTISTREAM (public broadcast)** only when ready to publish. Outputs begin only after compatible PS5 media arrives and a video keyframe is available. The ongoing notification shows each platform's state, recent send rate, buffer delay, reconnect count, and skipped stale packets.
5. If a platform is stuck, tap **Reconnect stream outputs**. The sender waits for a clean keyframe and then establishes a fresh RTMPS session. **Stop receiver and all outputs** ends the session.
6. Use **Start PS5 network connection test** for a private packet-count diagnostic. That button never sends a public broadcast.

## Video limits

The current implementation passes incoming H.264 video through unchanged. It has no Android video decoder, compositor, resolution converter, or video encoder, so it cannot apply an on-stream overlay, make a 4K stream, or choose output bitrate. All platforms receive the same input resolution. Kick's published maximum is 1920×1080, so a 4K-to-Kick output would require downscaling and transcoding. Do not assume this phone can encode 4K; Android codec support and sustained performance vary by device.

The health label describes this app's output queue only. It is not a platform health check or an internet speed test. A successful RTMPS publish acknowledgement does not prove that viewers see or hear the stream.

## Verification limits

Unit and emulator tests use synthetic RTMP media and fake publishing destinations. They verify protocol handling, retry behavior, bounded queues, and metadata generation; they cannot prove stable PS5 ingest, platform acceptance, playable video, viewer audio, or multi-hour phone thermals. Test each selected platform with its creator dashboard and an independent viewer before relying on it.

No screen, microphone, or camera capture is included. No media is archived. Phone safety stop conditions still end the service and require a conscious restart.
