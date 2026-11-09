# Authorized 25-second live overlay and sound-mix smoke test

Both OBS_PUBLIC_SMOKE_TEST=true and OBS_OVERLAY_MIX_SMOKE_TEST=true are required on the separate receiver to cause the protected FFmpeg relay to add @saevond overlay and an original 440 Hz synthetic tone at 22% gain. It sends the resulting program only to the configured Sleipnir destination and the enabled external platforms. The 25-second source is generated and time paced and does not access PS5 game data or copyrighted recordings. Revert both flags to false immediately after the test. No new private keys are requested. This tests media input and destination state, but true viewer-audible confirmation needs checking a recording/playback.

OBS_MUSIC_LIBRARY_JSON remains unpopulated until approved tracks with a demonstrated license and actual playable URLs are supplied, so this test must never be described as an NCS music test.
