# SweatyClanker remote music bridge

The Twitch bot can forward **control messages only** to SweatyClanker OBS Lite on Android. It does **not** stream audio files or upload copyrighted tracks.

## Feature switch

The GET /api/encoder/commands endpoint returns HTTP 404 until the Render web service explicitly provides an `ENCODER_BRIDGE_TOKEN` secret of at least 32 random characters. When enabled, it accepts only `Authorization: Bearer <secret>`. Invalid tokens return 401. The state + event cursor expires when the server restarts; clients must resync from current play/pause, station and music-volume state.

1. Generate and privately save a strong random token (32+ characters); configure it as Render service environment variable `ENCODER_BRIDGE_TOKEN`. Never commit it, paste it into chat, or expose it on a page.
2. In the Android development APK, use **Save private !play bridge token** to store the same secret with Android Keystore.
3. With an active, user-started public Twitch receiver and a licensed music file/playlist selected, Android polls https://twitch-gemini-ai-chatbot-sc-2.onrender.com/api/encoder/commands over HTTPS.
4. The bot commands `!play`, `!music pause`, `!music club`, `!music dubstep`, `!skip`, `!volume 22` update the bot's in-memory music state, and Android receives the authenticated control messages.
5. The endpoint's 200 response only proves **bridge authentication**, not that PS5 audio reaches Android or that music can be heard by Twitch viewers.

No endpoint permits remote start of PS5 ingest, public broadcasting, file downloads, or changing stream keys. Only broadcaster/moderators can issue control commands; bridge secrets must be rotated if shared. Keep experimental Android PS5/Twitch streaming in draft PR #48 until a real-device end-to-end test succeeds.
