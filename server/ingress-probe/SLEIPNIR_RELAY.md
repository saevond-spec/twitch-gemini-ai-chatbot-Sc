# Free RTMP receiver → Sleipnir relay (test mode)

The existing isolated Render Free service can receive RTMP through a temporary Pinggy TCP tunnel. It does not make the PS5 native Broadcast menu support a custom RTMP destination. All tests of PS5 routing remain **unverified**.

## Two separate publishing paths

- `/app/<name>`: diagnostic-only test source. Never forwards to Sleipnir.
- `/secure/<OBS_INGEST_PUBLISH_TOKEN>`: authenticated, time-limited relay source. NGINX invokes the loopback-only Node authorization callback on every publish. A valid token and explicitly enabled relay are required before starting an FFmpeg forwarder.

The RTMP receiver binds only to loopback inside the container; the external route uses a short-lived public TCP tunnel. The service terminates inbound and outbound media processes after 12 minutes. Public endpoint changes with each deployment.

## Secrets and opt-in

Configure these as secret environment variables in the **isolated** `sweatyobs-free-rtmp-probe` Render service, not the Twitch bot:

- `OBS_SLEIPNIR_RELAY_ENABLED=true`: explicit permission for this service to forward authenticated sources.
- `OBS_SLEIPNIR_STREAM_KEY`: genuine Sleipnir personal stream key. It is **not** available through the Sleipnir MCP connection and must not be placed in source code, logs or this chat.
- `OBS_INGEST_PUBLISH_TOKEN`: randomly generated 32+ character token using letters, digits, underscore, hyphen. This is the authorized RTMP stream name.

Without all three, authenticated publishing is rejected and the service remains diagnostic only. Never expose these values in the public `/status` JSON, screenshots, chat, or Git history.

For a compatible software encoder, publish to `rtmp://<temporary-remote-host>:<temporary-port>/secure/<token>`. The PS5 native Broadcast UI does not permit entering this address or changing its predetermined destination port. No DNS substitution is implemented.

## Verification gates

1. Run Node tests for publish authentication and relay args. These are not end-to-end tests.
2. Confirm NGINX starts and a synthetic stream can publish through the temporary public TCP tunnel to the diagnostic `/app` path.
3. Configure the private environment variables without revealing their values.
4. Send a compatible test source to the authenticated `/secure` path and observe nonzero `relayFrames` in internal diagnostics.
5. Query Sleipnir live status and both Twitch/Kick destination states; inspect viewer playback before declaring success.
6. Finally establish native PS5 compatibility separately. This remains an unverified hardware/platform constraint.

Do not enable forwarding for unauthenticated streams. The service does not support permanent 24/7 streaming under the free temporary tunnel policy.
