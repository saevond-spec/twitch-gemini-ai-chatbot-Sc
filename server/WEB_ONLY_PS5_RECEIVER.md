# Web-only PS5 receiver: native RTMP recovery

The October 24 APK evidence (increasing video/audio packet counters and RTMPS publish accepted) showed **a native RTMP listener**. The earlier web service used an HTTPS dashboard and a receiver agent that read from a separate nginx stream at `rtmp://127.0.0.1:1935/relay/ps5`. When that host was absent, the dashboard correctly displayed OFFLINE, but the original ingest path was missing.

## New experimental path

The existing `server/web-receiver-agent.mjs` can now launch FFmpeg as a **single-client RTMP listener** instead of requiring an upstream nginx server:

```
OBS_RECEIVER_INPUT_MODE=direct-rtmp
OBS_RTMP_INGRESS_RESTRICTED=true
OBS_DASHBOARD_URL=https://<your-dashboard-host>
ENCODER_BRIDGE_TOKEN=<existing-shared-private-token>
node server/web-receiver-agent.mjs
```

`OBS_RTMP_INGRESS_RESTRICTED=true` is a **declaration by the operator**, not an automatic firewall: set it **only when** a real inbound TCP gateway/firewall is configured and verified. In direct mode, the FFmpeg process listens on `0.0.0.0:1935` using RTMP application `/app`. FFmpeg's generic RTMP listener does **not** safely authenticate Twitch-style publish keys. Do not publicly expose this port without source IP restrictions or a gateway authentication design. No new infrastructure has been provisioned.

The existing `existing-nginx` mode is the default and remains unchanged. Direct mode starts processing only when a user presses a dashboard control. Diagnostic mode decodes locally to null; it does not send the feed to Sleipnir. The start action sends one RTMPS feed to the user's configured Sleipnir target. The watchdog stops the FFmpeg process if its dashboard control channel is unavailable.

## Critical deployment obstacle

Render's public web endpoint only forwards **HTTP**, not raw inbound RTMP/TCP on port 1935. A service listening on 1935 inside the existing Render web process will not make it accessible from a PS5. Direct mode therefore requires a separately verified raw-TCP ingress host or managed TCP relay. A simple website, DNS rewrite, or Sleipnir MCP token cannot supply that transport.

Twitch's PS5 native broadcast uses Twitch-managed ingests. A 2026 community experiment found that redirecting a plaintext `contribute.live-video.net` RTMP hostname to an RTMP listener was possible in its network setup. That is **not** proof of compatibility with the user's current PS5 firmware or network, nor authorization to redirect arbitrary traffic. A domain-level DNS override alone is not reliable until we prove the exact hostname/port and the receiver's publish handshake; RTMPS endpoints protected by certificate verification cannot be replaced this way.

## Test gates

1. Run `node --test test/obs-web-direct-rtmp.test.js` on the branch.
2. Verify an RTMP publisher can connect to the listener in a private, firewall-restricted local test. Count video/audio packets and confirm a fresh keyframe; FFmpeg frame count is not proof of PS5 origin by itself.
3. Validate the authorized PS5 route to TCP 1935 from its network, **without** changing its DNS until the receiver is reachable and measured.
4. Use diagnostic mode first, with no downstream broadcast; then obtain explicit approval to enable Sleipnir/public distribution.
5. Compare network drops, stale-keyframe recovery, receiver heartbeat loss, and 60-minute endurance to the October 24 baseline.
6. Display receiver TCP bind, actual publish, decoder frames, Sleipnir publish and destination playback as **separate** states.

No APK is built, no platform visibility or destination is changed, no DNS is modified, and no live public broadcast is started. A real PS5-to-Sleipnir test remains outstanding.
