# SweatyOBS remote encoder

`sweatyobs/` contains the Android remote, Linux encoder host, and standalone session/control API. The phone, host, and API run independently of SweatyClanker.

## Phone app

The phone is a control panel. It sends a short-lived admin session over verified HTTPS, then sends small start, stop, reconnect, music, and status requests. It does not capture, receive, encode, or upload gameplay media. It does not ask for a PS5 IP or platform stream keys. A migration clears the older app's saved RTMPS keys/URLs, PS5 IP, local music references, and persisted audio-file permissions from this phone.

The phone's default API URL is the standalone SweatyOBS Render service at `https://sweatyobs-control-api.onrender.com`. It is separate from SweatyClanker and carries admin/control requests only; it is not the video encoder or a stream relay. Starting and reconnecting require a recent host heartbeat. The host sends a per-process instance ID: if the same host process reconnects after a network outage, the API preserves its reported running intent; a restarted host or control API fails closed to STOPPED and requires a fresh Start. An undelivered stale Start is also discarded.

The Render Blueprint adds this control API as a free web service. Free services can spin down after 15 minutes without inbound requests and can restart; the host's 1.5-second polling keeps it active while connected, but a control API restart resets desired state and stops the host stream on its next poll. Use an always-on paid control API service for uninterrupted multi-hour sessions. The API carries only small control/status JSON; video never passes through Render.

## Encoder host

`server/remote-run.mjs` runs on an operator-controlled Linux host. It waits for an authenticated phone command, starts one FFmpeg process per configured destination, and retries failed destinations independently with capped exponential backoff and jitter. The Twitch, YouTube, and Kick keys belong in the host-only target file, which must be chmod `600`. They are never sent to the Android app or the control API.

The host expects a local RTMP source at `rtmp://127.0.0.1:1935/relay/ps5`. The PS5-to-host ingest gateway is not installed or verified by this project. Current PS5 broadcasts are documented around linked streaming services; custom RTMP/DNS interception is unverified. Do not defeat TLS or certificate checks.

### Host configuration

Set these environment variables on the Linux host:

```sh
ENCODER_SERVICE_URL=https://your-control-api.example
ENCODER_REMOTE_HOST_TOKEN=<same-strong-random-token-as-the-control-API>
MULTISTREAM_TARGETS_FILE=/etc/sweatyobs/targets.json
# Optional. Omit if the host will stream game audio only.
LICENSED_MUSIC_DIR=/srv/sweatyobs/licensed-music
```

`targets.json` contains one to three entries, for example:

```json
[
  {"platform":"twitch","url":"rtmps://ingest.example/app/REDACTED"},
  {"platform":"youtube","url":"rtmps://ingest.example/live2/REDACTED"},
  {"platform":"kick","url":"rtmps://ingest.example/app/REDACTED"}
]
```

Replace the example URLs with current values from each platform dashboard. Keep the file out of Git, set mode `600`, and rotate any key that has been exposed. Then run:

```sh
npm run start:host
```

The standalone `sweatyobs-control-api` Render service needs `ENCODER_ADMIN_KEY` and `ENCODER_REMOTE_HOST_TOKEN`. Use different random values for those two settings. The remote host token is shared only by the API and this host. `ENCODER_BRIDGE_TOKEN` is reserved for the older SweatyClanker music/diagnostics bridge and must not be reused for the remote host. Configure `ENCODER_SERVICE_URL=https://sweatyobs-control-api.onrender.com` on the host and build the Android remote against the same HTTPS origin.

## Capacity estimate

For 6 Mbps total output per platform, 6 hours/day and 30 days/month:

- Three outputs require 18 Mbps of steady outbound capacity. Reserving 30% of the link for headroom means at least `18 / 0.70 = 25.7 Mbps` of measured upload capacity.
- Egress is `6 Mbps × 3 × 6 h/day × 30 days ÷ 8`, about **1,458 GB (1.46 TB) per month**, before protocol overhead.
- Across 730 days at six hours/day, that is **4,380 streaming hours** and about **35.5 TB** of outbound media before protocol overhead.
- At 4K, calculate with the actual PS5 source bitrate; this app passes video through and does not upscale or re-encode it. A stable 4K stream therefore depends on PS5 ingest compatibility, host CPU/network capacity, and each platform's current ingest rules.

Free web tiers are not suitable substitutes for a continuously running video host. Render's free web services can sleep when idle, and its included outbound data is far below this workload. Check current service limits and pricing before selecting a host.

## Verification and limits

Run `npm test` from this directory. A two-year model covers 730 daily sessions of six hours, with independent synthetic destination resets at an assumed 1 per 168 streaming hours. It checks process isolation and retry behavior with fake FFmpeg children, including the 30-second retry cap. This is not a two-year real-network test: it does not publish or exercise an RTMP media path and cannot predict real outages. The suite does not contact Twitch, YouTube, Kick, Render, a PS5, or a real key. Android device/build checks require Gradle, Android SDK, and a test device. The host still needs a synthetic local RTMP source and a separately installed receiver before end-to-end validation. `LIVE_UNVERIFIED` means FFmpeg reports mux progress; it does not prove the platform accepted the stream or viewers can watch it.

Still needed on real equipment: verify PS5-to-host ingest, PS5 keyframe recovery, 4K passthrough, host thermal/network behavior, all three destination dashboards, and music audio. Never test with a public broadcast until each private synthetic test passes.
