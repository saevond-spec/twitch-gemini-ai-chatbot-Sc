# Selected real music track live test

Only if **both** OBS_PUBLIC_SMOKE_TEST=true and OBS_CC0_SELECTED_TRACK_TEST=true are set on the isolated receiver, publish the existing 25-second generated video and use the selected-track FFconcat mixer to fetch an actual MP3 file: Classical Duo No. 24002 from Keynata Commons at https://carf-coder.github.io/keynata-commons/release/tracks/classical_duo_24002/classical_duo_24002.mp3. The project claims the track is CC0: https://carf-coder.github.io/keynata-commons/ . This is **not** an NCS track and is never added to the user's saved selection.

Music mix uses game audio 85%, track audio 22%, with the @saevond overlay. Only 1 test track is selected and auto-next is off. This is a bounded live test for the already-authorized Twitch/Kick destinations. Do not claim successful remote audio playback from FFmpeg frames alone. Check remote input resolution, both destinations' states, relay status, and if possible direct viewer playback.

Immediately disable both flags after testing. The test should never run on normal receiver startup without explicit opt-in.
