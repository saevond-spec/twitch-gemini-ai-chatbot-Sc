# Web studio workflow and APK parity

The web studio controls a receiver agent through outbound HTTPS polling. It does
not turn an HTTP-only Render service into a DNS/RTMP listener. No new host or paid
service is provisioned by this patch.

## User flow

1. Unlock `/obs-web` with ADMIN_API_KEY.
2. Save Sleipnir URL/key and the stream profile.
3. Connect the agent on a host already running the PS5 nginx ingest/relay.
4. Test PS5 ingest. This runs FFmpeg to a null output; it sends no platform video.
5. Go live explicitly. This sends one feed to Sleipnir and therefore every enabled
   destination in that account. Manage destinations in Sleipnir.
6. Reconnect or stop processing. Stop ends this agent's FFmpeg process, not nginx,
   DNS or PS5 broadcasting. End the broadcast on the PS5 too.

## Receiver agent setup

Requires Node 22+, system FFmpeg with libx264/AAC/drawtext and fonts, and the existing
nginx relay available at `rtmp://127.0.0.1:1935/relay/ps5`. The nginx setup must
actually forward the PS5 publish into that private path; the diagnostic-only config
from generate-config.mjs may need adjustment by the operator before this works.

Set these environment variables privately on that host:

- OBS_DASHBOARD_URL: HTTPS origin of the deployed dashboard
- ENCODER_BRIDGE_TOKEN: same existing token as the dashboard service (32+ characters)
- OBS_FFMPEG_PATH: optional path, otherwise `ffmpeg` from PATH

Run `node server/web-receiver-agent.mjs`. It initially processes no media. It
receives actions only after the owner requests them. No secret is printed. It
allows one receiver at a time, suppresses duplicate execution, rejects expired
commands and stops its media process after 30 seconds without control contact.
It intentionally does not automatically resume broadcasting after a failure.
A 5-second poll interval costs no Redis operations: command state is memory-only.
A dashboard process restart discards pending commands. A compatible receiver host
and a real PS5 route are still required and have not been deployed or verified.

## Settings persistence

When an existing Redis connection is available and ADMIN_API_KEY is at least 32
characters, startup loads AES-256-GCM encrypted settings from `obs:web:settings:v1`.
Encryption derives a separate key from the admin key with a namespace. Keep that
admin key stable; rotation requires migration. Failed writes preserve the previous
in-memory settings and report failure. Polling does not read/write Redis. Retention
is subject to the existing database's persistence/eviction policy. No extra database
is created. Explicit encrypted file storage still takes precedence. Without either
backend the UI continues to identify session-only storage.

## Feature status

| APK feature | Web implementation |
|---|---|
| URL/key save | Masked UI; encrypted database/file storage when configured |
| PS5/receiver addresses | Separate reference fields; do not configure DNS |
| Ingest diagnostic | Agent decodes to null; reports processed video frames |
| Start / reconnect / stop | Connected agent controls; disabled without fresh heartbeat |
| Quality | Original video, 540p30, 720p30, 1080p30 |
| Rotate gameplay | 180-degree rotation before brand overlay |
| Brand overlay | Basic magenta border and @saevond label |
| Game volume | Applied on next start/reconnect |
| Music play/pause/skip/mute/station/volume | Existing remote player and its existing bridges |
| Metadata | Saved title/game/keywords and description copying |
| Timeline | Last 100 server-memory command/state events, credential-free |
| Platform destinations | Managed in Sleipnir, one outgoing feed |
| Live chat / animated overlay | Not implemented by new receiver agent |
| Mix music into new receiver output | Not implemented; player audio alone is not broadcast audio |
| Local file picker / remote NCS catalog / shuffle / auto-next | Not ported to receiver agent |
| Preview player | Not implemented; use platform preview for viewer verification |
| Phone thermal / battery checks | Android-specific; not measured by web app |
| Listener/DNS start and stop | Host configuration, outside media-process controls |

The UI explicitly identifies these limits. Do not describe this patch as complete
APK parity or proven end-to-end streaming.

## Validation

26 targeted checks cover storage encryption/restart/failures, authentication,
command expiry, stop precedence, offline rejection, duplicate-safe polling, profile
validation, diagnostics, and a real local FFmpeg render. No live platform publishing
was performed in tests. Phone layout still requires browser verification.
