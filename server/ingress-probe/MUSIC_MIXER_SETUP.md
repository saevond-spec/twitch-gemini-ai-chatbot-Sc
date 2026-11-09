# Browser music library -> cloud mixer

The existing OBS web UI saves the preferred tracks, volume (default 22%), shuffle, auto-next and play-on-stream-start. The isolated cloud receiver fetches this profile when an authorized publish begins.

The two Render services require the **same** private `OBS_MUSIC_SYNC_TOKEN` (32+ characters). The dashboard service also needs `OBS_MUSIC_LIBRARY_JSON`, an array of independently approved items with `id`, `title`, `artist`, `genre`, `license`, `credit`, `streamApproved: true`, and a direct HTTPS `sourceUrl`. The receiver needs `OBS_MUSIC_AUTOPLAY_ENABLED=true` and `OBS_MUSIC_ALLOWED_HOSTS` listing exact trusted file-hosting domain names. Neither the token nor private audio source URLs should be displayed to unauthenticated users.

Selected tracks are assembled into an FFconcat playlist at stream startup. A stream with no approved selected tracks falls back to game audio only. `OBS_PUBLIC_SMOKE_TEST` remains disabled. The mixer uses FFmpeg's `amix` at 22% music volume and optional @saevond branded drawtext overlay. Free CPU limits may affect transcoding. Do not claim that music is audible to Twitch/Kick until a licensed audio file is supplied and stream playback is checked.

Expected catalog categories, based on the prior APK request, are Mixed, Club/House, Dubstep/Bass and Pop/Trap. The proposed ~100 songs were not physically bundled in the APK source and none are fabricated here. NCS usage requires appropriate credit and adherence to current terms; rules may differ across streaming destinations.

The temporary Pinggy tunnel remains a test network path, not a permanent native PS5 broadcast route.
