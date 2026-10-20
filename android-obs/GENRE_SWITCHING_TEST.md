# SweatyClanker OBS Lite v0.1.8 — Local genre switching

Scope: draft Android APK only; not deployed to SweatyClanker's production bot. 
Select Club, Dubstep, or Mixed in the app. Use **Add licensed Club songs** and **Add licensed Dubstep songs** to select local audio files with appropriate rights for livestream/VOD use. Files remain on the phone; the app stores content URIs, not downloadable music.

Defaults: **Mixed**, Shuffle **ON**, Auto-next **ON**, music volume **22%**. Each genre accepts up to 20 distinct selected files. Mixed draws from both libraries and avoids immediate track repeats in shuffle mode.

Switching a genre or tapping Skip while a public Twitch test is active requests the next song from the selected library. Actual local files are decoded in a background thread; incoming PS5 game audio continues through its separate mixer. At a natural track boundary, auto-next queues a new selection. A decoder delay may repeat the prior track briefly instead of interrupting gameplay.

The authenticated optional bot control bridge now forwards station changes with their actual genre rather than resetting the same song. Bot's existing `!music club` / `!music dubstep` commands can change local tracks only once the matching private bridge token is configured on both bot and Android. Mixed is selectable in the app; separate bot support for `!music mixed` is not yet deployed.

No real PS5-to-phone RTMP or Twitch viewer playback has been confirmed. The PS5 DNS experiment is reversible. The APK can show a local receiver ready even if the PS5 never sends packets; do not represent that as live broadcasting.

Verification gate: Android unit tests for playlist modes/shuffle/empty libraries, emulator genre UI test, Android APK build, then physical PS5 packet counts and independent Twitch video/audio check. No stream key or track files are committed to GitHub.
