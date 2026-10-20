# SweatyClanker encoder MVP (NOT deployed)

This is a separate, local/VM-side FFmpeg prototype. It takes **an authorized gameplay feed**, mixes local rights-cleared audio and pushes one combined RTMP output. It is **not** a PS5 capture solution or a phone-only Twitch audio injection method. PS5 direct-to-Twitch streams cannot have third-party audio added midflight. To use this live, supply an authorized capture device, encoded gameplay feed, or other supported source and sufficient continuously-running compute. Render free web hosting is not a reliable live video-encoding platform.

## Inputs and security

- Install Node 22+ and FFmpeg with RTMP/RTMPS and AAC support on your own host.
- Put licensed MP3/WAV/OGG/FLAC files under an absolute path of your choice. Add a catalog.json mirroring catalog.example.json. The "rights" string is metadata and does **not** confer permission; confirm licensing for Twitch streams, VODs, and clips and retain proof.
- GAMEPLAY_SOURCE must be a capture feed URL (RTMP/RTMPS/SRT) or absolute existing video file path. The source **must have audio**. For a video source without audio, use an alternate FFmpeg graph (not currently supported).
- TWITCH_RTMP_URL contains the full private Twitch ingest URL, including your stream key. **Never add it to GitHub, screenshots or logs.** Do not use this same URL for GAMEPLAY_SOURCE.
- ENCODER_CONTROL_TOKEN is a randomly-generated 32+ character secret. The authenticated control endpoint listens on 127.0.0.1 only; do not open or port-forward it publicly without a separate trusted TLS/auth proxy.
- ENCODER_COPY_VIDEO=true uses stream copy, requiring a Twitch-compatible H.264 source; use false to transcode. Start with a source that already meets Twitch's bitrate and keyframe guidance.

Example environment (do not commit real values):

    export GAMEPLAY_SOURCE=rtmp://127.0.0.1:1935/gameplay/live
    export TWITCH_RTMP_URL='rtmps://<Twitch ingest hostname>/app/<secret-stream-key>'
    export LICENSED_MUSIC_DIR=/absolute/path/to/licensed-music
    export ENCODER_CONTROL_TOKEN='<random 32+ character token>'
    node encoder/run.mjs

The catalog starts paused; launch licensed tracks with:

    curl -H "Authorization: Bearer $ENCODER_CONTROL_TOKEN" -H "Content-Type: application/json" \
      -d '{"action":"play"}' http://127.0.0.1:8787/control

Actions: play, pause, skip, station (with station "dubstep" or "club"). The music feeder continuously supplies silence while paused. The controls have not yet been wired to chat: the existing SweatyClanker bot's \`!play\` broadcasts to its website WebSocket only. Do not tell viewers that music is audible until the full real ingest/audio path is verified.

## Current limitations

- No PS5 direct capture and no automatic ability to insert music into a pre-existing broadcast.
- No guaranteed free always-on host. Encoding and outbound bandwidth consume resources; free plans can sleep or disallow the workload.
- No automated reconnect, stream failover, peak limiting, audio ducking, robust synchronization, multi-user control, music attribution overlay, or live output verification yet.
- Free-to-listen YouTube playlists are **not** downloadable/redistributable tracks for this mixer. Obtain explicit appropriate rights and actual music files.
- \`!play\` bot bridge is a later, separately secured integration. Never expose the control token to Twitch users.
- Control/status endpoint alone does not prove Twitch ingest is playing.
