# SweatyOBS Linux encoder host

This host is separate from the Android remote and the standalone SweatyOBS control API. SweatyClanker is not in the phone/host control path. Render only handles admin unlock and small control/status JSON. The host below handles media after it receives a command.

## Required pieces

- An always-on Linux host with FFmpeg and Node.js 22.
- An RTMP receiver/relay that provides `rtmp://127.0.0.1:1935/relay/ps5` to FFmpeg.
- A private RTMPS target file for Twitch, YouTube, and/or Kick.
- `ENCODER_REMOTE_HOST_TOKEN` shared only with the control API, plus the API HTTPS origin.
- A licensed music catalog and files in a host-only directory if remote music controls are used (optional for game-only streams).

The PS5 ingest piece is still unresolved. The current Sony PS5 guide describes broadcasting through linked streaming services; it does not document a user-configured RTMP destination. The proposed PS5 DNS mapping to a custom RTMP host remains a hypothesis and needs compatible synthetic and device checks. Do not bypass TLS or redirect an RTMPS endpoint.

The standalone Render control API defaults to a free web service in `render.yaml`, configured with one instance because its host lease and command state are in memory. Do not scale this API to multiple instances unless its lease/command state is moved to shared atomic storage. Render Free services sleep after 15 minutes with no inbound requests and can restart. Active host polls keep the service awake, but a service restart clears desired state and makes the host stop on its next poll. Use an always-on paid plan for long sessions where a control service restart must not end the broadcast. Render is a control plane only and does not carry media.

## Host process

Create a target file outside Git, readable only by the service account:

```sh
sudo install -d -m 700 /etc/sweatyobs
sudo install -m 600 /dev/null /etc/sweatyobs/targets.json
```

Add one to three entries with RTMPS URLs copied from platform dashboards. Those URLs contain credentials. Never print them, commit them, attach them to an issue, or store them on the phone.

Configure `ENCODER_SERVICE_URL=https://sweatyobs-control-api.onrender.com`, `ENCODER_REMOTE_HOST_TOKEN`, `MULTISTREAM_TARGETS_FILE`, and optionally `LICENSED_MUSIC_DIR` in the host service environment, then run `npm run start:host` from `sweatyobs/`. Run one host process per token; the API rejects a second instance while the current instance is still checking in. The process starts idle and waits for a phone command. It does not bind a public HTTP listener. The phone's admin key is a different value configured as `ENCODER_ADMIN_KEY` on the standalone SweatyOBS control API.

## Failure handling

Each destination gets its own FFmpeg process and music feeder. The FFmpeg input packet queues are capped at 128 video packets and 64 audio packets, and each decoded-music queue is capped at 2.4 seconds. A destination process that exits retries with full-jitter exponential backoff, starting below one second and capped at 30 seconds. A manual reconnect restarts each active output. A stalled output is restarted after its progress heartbeat stops for 15 seconds. A stopped desired state cancels scheduled retries. A temporary API network outage does not stop an already-running stream on the host; after a failed request the host waits 1.5 seconds before the next poll, and a 5-second request timeout can make the gap up to about 6.5 seconds. Starts and manual reconnects are rejected unless the host checked in recently. A candidate host waits and retries while the current host lease is fresh. If a process that previously held the lease later receives a conflict, it stops its local FFmpeg outputs; this fences a stale process after ownership changes. On reconnect after a lease expiry, the API preserves RUNNING only for the same host process instance that reported it; a restarted host or an API process restart is fail-closed to STOPPED, and the operator must press Start again.

`LIVE_UNVERIFIED` means FFmpeg reports output frame progress. It is not platform confirmation. The RTMPS target is not directly inspectable from the API. Output bitrate is reported only when FFmpeg provides a measured progress value; dropped packet counts are marked unknown because this host path does not measure them. FFmpeg stderr is kept in a bounded, URL-redacted in-memory tail for error classification and is not returned by the API. The current runtime does not claim per-output platform acceptance, viewer playback, or zero packet loss. Keyframe recovery after an output restart depends on the PS5 relay sending a new keyframe and still needs validation on a synthetic source and then a real PS5. The RTMPS URL is passed to FFmpeg as a process argument, so use a dedicated host account and restrict process-list access.

## Sandbox tests

`npm test` from `sweatyobs/` includes a two-year discrete-event scenario: 730 daily six-hour sessions, 76 seeded independent output resets, and a sustained outage that exercises capped backoff. The 1 reset per 168 streaming hours rate is a test assumption, not measured market/device data. It uses fake FFmpeg child processes and simulated progress/error events; it does not run a synthetic RTMP publisher/receiver or exercise an RTMP media path. No test uses real stream credentials or starts a public stream. End-to-end validation still needs a local synthetic RTMP publisher/receiver pair, then verified PS5 ingest, followed by private/unlisted platform tests with rotated credentials.

## Network math

At an assumed **6 Mbps total** per destination, three outputs use 18 Mbps of host egress. Reserving 30% link headroom gives a link target of `18 / (1 - 0.30) = 25.7 Mbps`. For six hours/day over 30 days, three outputs produce about `6 × 3 × 6 × 3600 × 30 ÷ 8 = 1,458,000 MB`, approximately **1.46 TB decimal** before protocol overhead. This is a capacity estimate, not a measurement. Use the actual video plus audio rate and measured host upload/egress allowance.
