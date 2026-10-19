<div align="center">

<img src="assets/banner.png" alt="SweatyClanker Twitch Chatbot Banner" width="100%">

# SweatyClanker Twitch Chatbot

**An AI-powered Twitch chat companion with DeepSeek and OpenAI provider failover.**

[![Built with Pollinations](https://img.shields.io/badge/Built%20with-Pollinations-8a2be2?style=for-the-badge&logo=data:image/png;base64,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&logoColor=white&labelColor=6a0dad)](https://pollinations.ai)
[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=for-the-badge)](#license)

</div>

---

## Features

<div align="center">
<img src="assets/features.png" alt="Features Overview" width="100%">
</div>

---

## Quick Start

A high-level checklist — the [Tutorial](#tutorial) below covers every step in detail.

1. **Fork this repository** and customize the bot's personality files
2. **Create a Twitch application** at [`dev.twitch.tv/console`](https://dev.twitch.tv/console) — note your Client ID & Secret
3. **Create DeepSeek and OpenAI API keys** to enable automatic provider failover
4. **Get a Pollinations API key** from [`enter.pollinations.ai`](https://enter.pollinations.ai)
5. **Create a free Upstash Redis database** at [`console.upstash.com`](https://console.upstash.com) — copy the Redis connection string
6. **Deploy your fork to Render** and fill in your environment variables
7. **Authorize the bot** by visiting `https://YOUR-APP.onrender.com/auth/login` while logged into the bot's Twitch account

That's it. No local install. No terminal commands.

---

## Tutorial

Full walkthrough for each requirement. Complete these in order.

<!-- ─── 1. FORK & DEPLOY ─────────────────────────────────── -->

<details>
<summary><strong>1 — Fork, Customize & Deploy to Render</strong></summary>

<br>

#### Fork the repository

1. Click **Fork** at the top of this GitHub repo
2. This creates your own copy where you can edit all files freely

#### Customize your bot

These files shape the bot's personality and behavior — edit them in your fork before deploying:

**`system_instructions.txt`** (required)

This is the bot's personality prompt — the active AI provider follows these instructions for every response. Define tone, character, rules, etc.

**`custom_commands.txt`** (optional)

Define static commands with instant responses — no AI call needed.

**`error_message.json`** (optional)

Override the default error messages to match your bot's personality.

#### Deploy to Render

Once your files are ready, click the button below to deploy your fork:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

1. Sign into [Render](https://render.com) with your **GitHub account**
2. Render will detect your fork and the `render.yaml` Blueprint
3. You'll see a form with all the environment variables — fill these in as you complete the sections below
4. Click **Deploy Blueprint** once every value is ready

> 💡 After the first deploy, every push to `main` in your fork automatically redeploys your bot.

</details>

<!-- ─── 2. TWITCH ──────────────────────────────────────── -->

<details>
<summary><strong>2 — Twitch Setup</strong></summary>

<br>

You need a **Twitch account for the bot** (can be your own or a separate account) and a **Twitch Developer application**.

#### Create the Twitch application

1. Log into the bot's Twitch account and enable **Two-Factor Authentication** in Twitch settings if you haven't already
2. Go to the [Twitch Developer Console](https://dev.twitch.tv/console)
3. Click the **Applications** tab, then **Register Your Application**
4. Fill in the form:
   - **Name:** anything you like (e.g. `SweatyClanker Bot`)
   - **OAuth Redirect URL:** `https://YOUR-APP.onrender.com/auth/callback`
     - Replace `YOUR-APP` with your actual Render service name — you can find it in your Render dashboard
   - **Category:** `Chat Bot`
5. Click **Create**

#### Get your credentials

1. Back on the **Applications** tab, click **Manage** on your new app
2. Copy the **Client ID**
3. Click **New Secret**, then copy the **Client Secret**
   - Store the secret somewhere safe — generating a new one invalidates the old one

#### Render environment variables

| Variable | Value |
|---|---|
| `TWITCH_USERNAME` | The bot account's Twitch username (lowercase) |
| `JOIN_CHANNELS` | Comma-separated list of channels to join, e.g. `channel1,channel2` |
| `TWITCH_CLIENT_ID` | Client ID from above |
| `TWITCH_CLIENT_SECRET` | Client Secret from above |

#### Authorize the bot (after deploy)

Once Render finishes deploying, visit:

```
https://YOUR-APP.onrender.com/auth/login
```

Make sure you're **logged into the bot's Twitch account** in your browser. The app will redirect you through Twitch's OAuth flow and store the tokens automatically.

> ⚠️ If you authorize with the wrong Twitch account, the bot will reject the token. Log out of Twitch, sign into the correct bot account, and visit `/auth/login` again.

</details>

<!-- ─── 3. AI PROVIDERS ─────────────────────────────────── -->

<details>
<summary><strong>3 — DeepSeek and OpenAI API Keys</strong></summary>

<br>

Configure both providers for automatic failover. DeepSeek is preferred by default; OpenAI takes over when DeepSeek returns an API, billing, rate-limit, or availability error. The bot temporarily stays on the working provider and probes the preferred provider again after the configured failback interval.

#### Create provider API keys

- Create a DeepSeek key at [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys).
- Create an OpenAI API key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys).

Keep the keys private. ChatGPT subscriptions and API usage are managed separately; the bot needs an OpenAI API key with API billing enabled.

#### Render environment variables

| Variable | Value |
|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `DEEPSEEK_MODEL` | Optional; defaults to `deepseek-chat` |
| `OPENAI_MODEL` | Optional; defaults to `gpt-4.1-mini` |
| `AI_PROVIDER_ORDER` | Optional; defaults to `deepseek,openai` |
| `AI_FAILBACK_INTERVAL_MS` | Optional; defaults to `60000` |
| `AI_MAX_FAILBACK_INTERVAL_MS` | Optional; defaults to `300000`; caps repeated-failure backoff |

Set at least one AI key for the bot to start. Set both keys to enable cross-provider failover. If both providers fail, chat uses the local response fallback.

#### Verify provider credentials safely

After deployment, send one admin-authenticated request to `POST /api/ai/verify-credentials` with `Authorization: Bearer $ADMIN_API_KEY`. The route uses read-only provider endpoints, returns authentication status and HTTP codes, and never returns the API keys, OpenAI model list, or DeepSeek balance. `verified` confirms provider API authentication; it does not identify the human account owner. HTTP 401 means the key was rejected; `permission_limited` means the verification endpoint could not be accessed and does not by itself prove chat access is invalid. A DeepSeek result can be authenticated while `accountAvailable` is false.

```sh
curl -sS -X POST "$SWEATYCLANKER_URL/api/ai/verify-credentials" \
  -H "Authorization: Bearer $ADMIN_API_KEY"
```

The diagnostic is limited to two requests per minute. Do not paste either API key into chat or a support ticket.

</details>

<!-- ─── 4. POLLINATIONS ────────────────────────────────── -->

<details>
<summary><strong>4 — Pollinations Setup</strong></summary>

<br>

Pollinations powers the `!image`, `!video`, `!tts`, and `!song` commands.

#### Get your API key

1. Go to [enter.pollinations.ai](https://enter.pollinations.ai)
2. Log in with your **GitHub account**
3. From your dashboard, create an API key
4. Copy the key

#### Render environment variable

| Variable | Value |
|---|---|
| `POLLINATIONS_API_KEY` | Your Pollinations API key |

> 💡 Pollinations is an actively evolving platform — available models change frequently. If a command stops working, check [enter.pollinations.ai](https://enter.pollinations.ai) for current model names and update your environment variables accordingly.

</details>

<!-- ─── 5. UPSTASH ─────────────────────────────────────── -->

<details>
<summary><strong>5 — Upstash Redis Setup</strong></summary>

<br>

Upstash provides a free persistent database that stores chat logs, media history, and OAuth tokens across Render restarts.

#### Create a database

1. Go to [console.upstash.com](https://console.upstash.com) and create an account
2. Click **Create Database**
3. Give it a name (e.g. `twitch-bot`)
4. Select a region close to your Render region (e.g. **US-East-1** for Virginia)
5. Select the **Free** tier
6. Click **Create**

#### Get the connection string

1. On the database details page, find the **Redis** section
2. Copy the connection string that looks like:
   ```
   redis://default:xxxxxxxxxxxx@us1-xxxxxx.upstash.io:6379
   ```

#### Render environment variable

| Variable | Value |
|---|---|
| `UPSTASH_REDIS_URL` | The full `redis://...` connection string |

</details>

---

## FAQ

<details>
<summary><strong>How much can I use the bot each day?</strong></summary>

<br>

Each provider has separate API limits and billing. When the active provider fails, the bot can send the request to the other configured provider, which uses that provider's API quota. Configure both keys for failover and check each provider's dashboard for current usage and limits.

</details>

<details>
<summary><strong>How does AI provider failover work?</strong></summary>

<br>

The bot tries providers in AI_PROVIDER_ORDER, which defaults to DeepSeek followed by OpenAI. After a failure, it switches to the other configured provider and temporarily keeps using the working provider. Repeated failures use exponential backoff, capped by AI_MAX_FAILBACK_INTERVAL_MS, and messages received while every provider is cooling down do not trigger more API calls. The router probes providers again after cooldown expiry. If all providers fail, local chat responses remain available.

</details>

<details>
<summary><strong>Does the chat AI search the web?</strong></summary>

<br>

The current chat provider path sends text chat completions and does not attach a web-search tool. It can use only the context supplied by the bot and the conversation.

</details>

<details>
<summary><strong>How do I see chat logs and the media gallery?</strong></summary>

<br>

Your Render service URL doubles as a public web dashboard that displays your channels' chat logs and generated media gallery. It's the same base link you used to authorize your bot (e.g. `https://YOUR-APP.onrender.com`).

</details>

<details>
<summary><strong>The Pollinations command isn't working — what do I do?</strong></summary>

<br>

Pollinations is an actively evolving platform — available models change frequently. You can update the model names in your environment variables at any time. Current model names are listed on the same page as your API key at [enter.pollinations.ai](https://enter.pollinations.ai).

</details>

<details>
<summary><strong>Will Render spin down after inactivity?</strong></summary>

<br>

The bot has a built-in keepalive mechanism to prevent Render's free-tier spin-downs. If the bot is still spinning down, please [open an issue](../../issues).

</details>

<details>
<summary><strong>Does the bot work while my stream is offline?</strong></summary>

<br>

Yes. As long as the Render service is running, the bot stays connected to your Twitch chat 24/7 — live or offline.

</details>

<details>
<summary><strong>Can the chat AI analyze images or videos?</strong></summary>

<br>

The DeepSeek/OpenAI failover path sends text chat messages. It does not pass image or video content to either chat provider. Media generation commands use their separate provider integrations.

</details>

<details>
<summary><strong>Do I need both AI provider keys?</strong></summary>

<br>

One key is enough for AI chat to run. Both DEEPSEEK_API_KEY and OPENAI_API_KEY are needed for automatic cross-provider failover. OpenAI API usage has its own billing and is separate from a ChatGPT subscription.

</details>

<details>
<summary><strong>Can I run this locally?</strong></summary>

<br>

Yes, for development and testing. Create a `.env` file with the same variable names from `render.yaml`, then run `npm start`.

> ⚠️ **Use separate credentials for local development.** Create a different Twitch application (with `http://localhost:3000/auth/callback` as the redirect URL) and either omit `UPSTASH_REDIS_URL` or point it to a separate database. Using the same credentials as production will overwrite your live tokens and data.

Once running, visit `http://localhost:3000/auth/login` to authorize.

</details>

---

## Automatic Twitch stream highlights

The optional highlight detector listens to live chat reactions and `channel.follow` EventSub events. A follow strengthens nearby chat evidence; it does not create a highlight on its own. DeepSeek scores candidate moments from text context, so it does not watch or hear gameplay. When a tracked stream ends and its archive VOD is available, the bot sends up to five selected moments by default to Amaana. Amaana joins the source clips into a landscape highlight video, cuts a vertical Short from each segment, and uploads them as private YouTube drafts for owner review. A stream without qualifying reactions produces no draft.

Set these variables on this Render service:

- `CLIP_WEBHOOK_URL=https://amaana-yt.onrender.com/api/twitch/vod-clips`
- `CLIP_WEBHOOK_KEY` to Amaana's `AGENT_KEY` value; keep it secret.
- `HIGHLIGHT_DETECTION_ENABLED=true`

Optional controls: `HIGHLIGHT_WINDOW_SECONDS`, `HIGHLIGHT_MIN_MESSAGES`, `HIGHLIGHT_COOLDOWN_SECONDS`, and `HIGHLIGHT_MAX_CLIPS` (one to eight). The Twitch bot must be authorized with `moderator:read:followers` for follow signals. Amaana separately needs the broadcaster's Twitch clip permission and Twitch VOD storage and Clips enabled. Source clips on Twitch can be visible independently of the private YouTube drafts.

The bot must be running while the stream is live to observe chat. Render Free web services can spin down after 15 minutes without inbound traffic, so check uptime or use an always-on service if every stream must be covered. A regular stream ending is enough to start the VOD handoff; no 24-hour stream is needed.

The eight legacy BullMQ handlers in this repository only log jobs. They are disabled by default to avoid idle Redis traffic; set `WORKERS_ENABLED=true` only when those handlers are needed. The highlight detector runs separately and does not require BullMQ.

## License

[MIT](LICENSE) — use freely, attribution appreciated!

---

<div align="center">
  <a href="https://ko-fi.com/virtuallyjesse" target="_blank">
    <img src="https://storage.ko-fi.com/cdn/kofi2.png" alt="Support Me on Ko-fi" height="42px" style="height: 42px;">
  </a>
  <br>
  <sub>Made with ❤️ by <a href="https://github.com/VirtuallyJesse">VirtuallyJesse</a></sub>
</div>
