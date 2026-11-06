# Northflank deployment for SweatyClanker

This deployment is intentionally **bot-only**. The Docker image excludes the Android/SweatyOBS source tree so encoder work cannot change the Twitch bot runtime.

## Service

Create a Northflank **combined service** from this GitHub repository and use:

- Branch: `main`
- Build type: `Dockerfile`
- Dockerfile: `/Dockerfile`
- Build context: repository root
- Public port: `3000`
- Instances: `1`
- Health endpoint: `/healthz`

The bot must remain a continuously running service, not a cron job or one-off job.

## Required runtime variables

Set these in a Northflank secret group or directly on the service:

```env
TWITCH_USERNAME=sweatyclanker
TWITCH_CLIENT_ID=...
TWITCH_CLIENT_SECRET=...
JOIN_CHANNELS=saevond
DEEPSEEK_API_KEY=...
DEEPSEEK_MODEL=deepseek-chat
AI_PROVIDER_ORDER=deepseek
PORT=3000
```

Do not add OpenAI to `AI_PROVIDER_ORDER`. SweatyClanker is configured to use DeepSeek only, with local fallback behavior when DeepSeek is unavailable.

## Strongly recommended persistent variables

Carry these over from the current production service where configured:

```env
REDIS_URL=...
TWITCH_TOKEN_DATABASE_URL=...
ADMIN_API_KEY=...
EVENTSUB_SECRET=...
ENCODER_BRIDGE_TOKEN=...
CLIP_WEBHOOK_URL=...
CLIP_WEBHOOK_KEY=...
HIGHLIGHT_DETECTION_ENABLED=true
SLEIPNIR_LIVE_STATE_STALE_SECONDS=90
REDIS_REQUIRED=false
WORKERS_ENABLED=false
```

Also copy the existing engagement, welcome, retention, highlight, moderation, emote, and media variables from production if you want identical behavior.

## Public URL and Twitch OAuth

After Northflank assigns the service domain:

1. Set `PUBLIC_URL=https://<northflank-domain>`.
2. Add `https://<northflank-domain>/auth/callback` to the Twitch Developer application's OAuth redirect URLs.
3. Visit `https://<northflank-domain>/auth/login` while signed in to the SweatyClanker Twitch account.
4. Confirm the callback reports the correct bot identity.

Do not remove the old Render OAuth redirect until Northflank has passed production checks.

## Acceptance checks before switching away from Render

Northflank is considered ready only when all of these pass:

1. `GET /healthz` returns HTTP 200.
2. `GET /readyz` reports Twitch connected, OAuth authorized, and AI ready.
3. Startup logs show SweatyClanker v3 booting successfully.
4. IRC joins the intended Twitch channel.
5. EventSub connects or fails gracefully without stopping IRC.
6. Chatter watcher initializes.
7. A real Twitch message is received.
8. SweatyClanker sends a test response.
9. Join/welcome behavior works without duplicate spam.
10. DeepSeek is the only enabled AI provider.
11. Sleipnir status can be observed without Twitch chat depending on it.
12. The service remains running continuously across an idle period.

Keep Render online during the migration. Only retire the old service after Northflank has passed these checks.
