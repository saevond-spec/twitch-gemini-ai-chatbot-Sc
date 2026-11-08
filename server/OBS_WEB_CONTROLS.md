# OBS web relay setup and diagnostics

`/obs-web` now uses an isolated `/api/obs-web` API, protected by the existing
`ADMIN_API_KEY`. Enter that key in the dashboard; it is held only in page memory
and cleared on lock or page exit. Relay stream keys are never returned by this API.

Controls:
- Save the Sleipnir RTMPS server URL and a masked stream key; blank preserves the
  existing key and the separate remove checkbox deletes it.
- Record a receiver IPv4 address for reference (this does not modify PS5 DNS).
- Check the saved Sleipnir server's TLS connection. Only the exact
  `ingest.sleipnir.tv` hostname, `/live` path, and 443/1936 ports are accepted.
  The probe verifies the TLS certificate, times out after five seconds, sends no
  stream key or video, and is throttled to once per ten seconds.
- Inspect authenticated encoder samples, with 90-second expiry, packet totals,
  reported destination states, and sender bitrate. No claim of viewer playback.
- Copy a diagnostic report without credentials or the reference receiver address.

## Storage

Without the following configuration, settings live only in server memory and the
UI warns they will be lost on restart:

- `OBS_CONTROL_SETTINGS_FILE`: absolute file path on an existing persistent volume.
- `OBS_CONTROL_ENCRYPTION_KEY`: 64 hexadecimal characters (32 random bytes),
  generated securely and kept stable across deployments.

Settings use AES-256-GCM and atomic replacement with mode 0600. The containing
directory must already exist and be writable. Decryption failure blocks overwriting
the file. Do not commit keys or saved settings. Adding storage must not silently
provision a paid disk. Multiple server replicas would require shared storage and
coordination; this implementation is for one process.

## Remaining receiver integration

These settings are explicitly **staged**, not applied. The present receiver runner
still reads `MULTISTREAM_TARGETS_FILE`; it does not consume this setup store. No
receiver start/stop API or cloud PS5 receiver deployment exists in this patch.
Connecting that worker is required before the dashboard can start broadcasts.
This change does not alter Twitch bot behavior, PS5 DNS, platform visibility, or
start any stream. Existing encoder diagnostics feed the UI after their existing
authentication and validation gate.

## Validation

Run:
`node --test test/obs-web.test.js test/obs-control.test.js test/encoder-diagnostics.test.js test/sleipnirIntegration.test.js`

Verify the deployed page on a phone, unlock, save, reload settings, run the server
check, and verify status against real encoder telemetry. Local checks do not prove
PS5 ingestion, relay publish authentication, or destination playback.
