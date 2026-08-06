// ============================================================
// SETUP SCRIPT – SweatyClanker v3 (Full Production Setup)
// ============================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// NOTE: the old early-exit here (`if src/app.js exists, skip everything`)
// was removed on purpose. It caused a real outage: if app.js got committed
// to the repo but a newer file (e.g. src/config/index.js, or any of the
// modules below) hadn't been, this check passed and the whole script
// bailed out before writing the missing files. The per-file existsSync
// check in the write loop at the bottom already does the right thing —
// skip what's there, create what's missing — so that's the only guard we
// need. This script is idempotent and safe to run on every boot.

// ---- Ensure src/ directory exists ----
if (!fs.existsSync('src')) fs.mkdirSync('src');

// ---- Full file definitions ----
const files = {
  // ---- ROOT FILES ----
  '.env.example': `
# Twitch
TWITCH_USERNAME=your_bot_account
TWITCH_CLIENT_ID=your_twitch_app_client_id
TWITCH_CLIENT_SECRET=your_twitch_app_secret
JOIN_CHANNELS=channel1,channel2

# DeepSeek
DEEPSEEK_API_KEY=your_deepseek_api_key
DEEPSEEK_MODEL=deepseek-chat
AI_HISTORY_LENGTH=5
AI_TEMPERATURE=0.7
AI_MAX_TOKENS=1024
AI_TIMEOUT_MS=10000
AI_MAX_RETRIES=3
AI_CIRCUIT_BREAKER_THRESHOLD=5

# Redis
REDIS_URL=redis://...

# Cooldowns (seconds)
COOLDOWN_DURATION=1
USER_COOLDOWN=5

# Moderation
MAX_REPEAT_MESSAGES=3
MAX_CAPS_RATIO=0.7
ALLOW_LINKS=false

# Emotes
ENABLE_EMOTE_APPENDING=true
EMOTE_APPEND_EXCLUDE_PREFIXES=!,
ENABLE_7TV_EMOTES=true
ENABLE_BTTV_EMOTES=true
ENABLE_FFZ_EMOTES=false

# Auto‑messages
AUTO_MESSAGE_ENABLED=true
AUTO_MESSAGE_INTERVAL=300
AUTO_USE_DEEPSEEK=true
AUTO_QUIET_THRESHOLD=600
AUTO_WELCOME=true

# Media Generation (Pollinations)
IMAGE_COMMAND_NAME=!image
VIDEO_COMMAND_NAME=!video
TTS_COMMAND_NAME=!tts
MUSIC_COMMAND_NAME=!song

# Server
PORT=3000
LOG_LEVEL=info
IGNORED_USERNAMES=
ALLOWED_ORIGINS=https://yourdomain.com
PUBLIC_URL=https://your-app.onrender.com

# EventSub – correct WebSocket path
EVENTSUB_SECRET=your_event_sub_secret
EVENTSUB_WSS_URL=wss://eventsub.wss.twitch.tv/ws
`,

  '.gitignore': `
node_modules/
.env
logs/
*.log
tokens.json
custom_commands.txt
.DS_Store
`,

  'README.md': '# SweatyClanker v3 – Full‑Feature Twitch AI Bot',

  'src/config/index.js': `
import dotenv from 'dotenv';
import { createLogger } from '../logger/index.js';
dotenv.config();
const log = createLogger('CONFIG');
const requiredVars = {
  TWITCH_USERNAME: 'Twitch bot account name',
  TWITCH_CLIENT_ID: 'Twitch application Client ID',
  TWITCH_CLIENT_SECRET: 'Twitch application Client Secret',
  JOIN_CHANNELS: 'Comma-separated list of channels to join',
  DEEPSEEK_API_KEY: 'DeepSeek API key',
  EVENTSUB_SECRET: 'Secret for EventSub WebSocket verification',
};
const missing = Object.keys(requiredVars).filter(key => !process.env[key]);
if (missing.length) {
  log.error('Missing required environment variables:');
  missing.forEach(key => log.error(\`  - \${key}: \${requiredVars[key]}\`));
  process.exit(1);
}
const optional = {
  DEEPSEEK_MODEL: 'deepseek-chat',
  AI_HISTORY_LENGTH: 5,
  AI_TEMPERATURE: 0.7,
  AI_MAX_TOKENS: 1024,
  AI_TIMEOUT_MS: 10000,
  AI_MAX_RETRIES: 3,
  AI_CIRCUIT_BREAKER_THRESHOLD: 5,
  REDIS_URL: '',
  COOLDOWN_DURATION: 1,
  USER_COOLDOWN: 5,
  MAX_REPEAT_MESSAGES: 3,
  MAX_CAPS_RATIO: 0.7,
  ALLOW_LINKS: 'false',
  ENABLE_EMOTE_APPENDING: 'true',
  EMOTE_APPEND_EXCLUDE_PREFIXES: '',
  ENABLE_7TV_EMOTES: 'true',
  ENABLE_BTTV_EMOTES: 'true',
  ENABLE_FFZ_EMOTES: 'false',
  AUTO_MESSAGE_ENABLED: 'true',
  AUTO_MESSAGE_INTERVAL: 300,
  AUTO_USE_DEEPSEEK: 'true',
  AUTO_QUIET_THRESHOLD: 600,
  AUTO_WELCOME: 'true',
  IMAGE_COMMAND_NAME: '!image',
  VIDEO_COMMAND_NAME: '!video',
  TTS_COMMAND_NAME: '!tts',
  MUSIC_COMMAND_NAME: '!song',
  PORT: 3000,
  LOG_LEVEL: 'info',
  IGNORED_USERNAMES: '',
  ALLOWED_ORIGINS: '',
  EVENTSUB_WSS_URL: 'wss://eventsub.wss.twitch.tv/ws',
  PUBLIC_URL: '',
};
const env = { ...optional };
for (const [key, def] of Object.entries(optional)) env[key] = process.env[key] ?? def;
for (const key of Object.keys(requiredVars)) env[key] = process.env[key];
const convert = {
  AI_HISTORY_LENGTH: Number,
  AI_TEMPERATURE: Number,
  AI_MAX_TOKENS: Number,
  AI_TIMEOUT_MS: Number,
  AI_MAX_RETRIES: Number,
  AI_CIRCUIT_BREAKER_THRESHOLD: Number,
  COOLDOWN_DURATION: Number,
  USER_COOLDOWN: Number,
  MAX_REPEAT_MESSAGES: Number,
  MAX_CAPS_RATIO: Number,
  AUTO_MESSAGE_INTERVAL: Number,
  AUTO_QUIET_THRESHOLD: Number,
  PORT: Number,
  ALLOW_LINKS: Boolean,
  ENABLE_EMOTE_APPENDING: Boolean,
  ENABLE_7TV_EMOTES: Boolean,
  ENABLE_BTTV_EMOTES: Boolean,
  ENABLE_FFZ_EMOTES: Boolean,
  AUTO_MESSAGE_ENABLED: Boolean,
  AUTO_USE_DEEPSEEK: Boolean,
  AUTO_WELCOME: Boolean,
};
for (const [key, fn] of Object.entries(convert)) {
  if (env[key] !== undefined) {
    if (typeof env[key] === 'string' && (env[key].toLowerCase() === 'true' || env[key].toLowerCase() === 'false')) {
      env[key] = env[key].toLowerCase() === 'true';
    } else {
      env[key] = fn(env[key]);
    }
  }
}
const publicUrl = env.PUBLIC_URL || (process.env.RENDER_EXTERNAL_HOSTNAME ? \`https://\${process.env.RENDER_EXTERNAL_HOSTNAME}\` : \`http://localhost:\${env.PORT}\`);
export const config = {
  twitch: {
    username: env.TWITCH_USERNAME,
    clientId: env.TWITCH_CLIENT_ID,
    clientSecret: env.TWITCH_CLIENT_SECRET,
    channels: env.JOIN_CHANNELS.split(',').map(c => c.trim()).filter(Boolean),
    ignoredUsers: (env.IGNORED_USERNAMES || '').split(',').map(u => u.trim().toLowerCase()).filter(Boolean),
  },
  deepseek: {
    apiKey: env.DEEPSEEK_API_KEY,
    model: env.DEEPSEEK_MODEL,
    maxHistory: env.AI_HISTORY_LENGTH,
    temperature: env.AI_TEMPERATURE,
    maxTokens: env.AI_MAX_TOKENS,
    timeoutMs: env.AI_TIMEOUT_MS,
    maxRetries: env.AI_MAX_RETRIES,
    circuitBreakerThreshold: env.AI_CIRCUIT_BREAKER_THRESHOLD,
  },
  redis: { url: env.REDIS_URL || '' },
  cooldown: { global: env.COOLDOWN_DURATION, perUser: env.USER_COOLDOWN },
  moderation: { maxRepeats: env.MAX_REPEAT_MESSAGES, maxCapsRatio: env.MAX_CAPS_RATIO, linkFilter: env.ALLOW_LINKS },
  emotes: {
    enable: env.ENABLE_EMOTE_APPENDING,
    excludePrefixes: (env.EMOTE_APPEND_EXCLUDE_PREFIXES || '').split(',').map(p => p.trim().toLowerCase()),
    sevenTv: env.ENABLE_7TV_EMOTES,
    bttv: env.ENABLE_BTTV_EMOTES,
    ffz: env.ENABLE_FFZ_EMOTES,
  },
  auto: {
    enabled: env.AUTO_MESSAGE_ENABLED,
    interval: env.AUTO_MESSAGE_INTERVAL,
    useDeepSeek: env.AUTO_USE_DEEPSEEK,
    quietThreshold: env.AUTO_QUIET_THRESHOLD,
    welcome: env.AUTO_WELCOME,
  },
  media: {
    imageCommand: env.IMAGE_COMMAND_NAME || '!image',
    videoCommand: env.VIDEO_COMMAND_NAME || '!video',
    ttsCommand: env.TTS_COMMAND_NAME || '!tts',
    musicCommand: env.MUSIC_COMMAND_NAME || '!song',
  },
  server: {
    port: env.PORT || 3000,
    trustProxy: 1,
    allowedOrigins: env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(',') : [],
    publicUrl: publicUrl,
  },
  eventsub: {
    secret: env.EVENTSUB_SECRET,
    wssUrl: env.EVENTSUB_WSS_URL || 'wss://eventsub.wss.twitch.tv/ws',
  },
};
log.info('✅ Configuration validated successfully');
`,

  'src/app.js': `
// ============================================================
// SWEATYCLANKER v3 – MAIN APPLICATION
// ============================================================
import express from 'express';
import expressWs from 'express-ws';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config/index.js';
import { logger, createLogger } from './logger/index.js';
import { connectRedis, getRedis } from './storage/redis.js';
import { initAuth, exchangeCodeForToken, isAuthorized } from './twitch/auth.js';
import { DeepSeekClient } from './ai/client.js';
import { buildUserPrompt } from './ai/prompt.js';
import { builtins, loadCustomCommands, saveCustomCommand, deleteCustomCommand } from './commands/index.js';
import './commands/builtins.js';
import { Moderation } from './moderation/index.js';
import { CooldownManager } from './utils/cooldown.js';
import { initializeEmotes, getRandomEmote, setEmotePools } from './twitch/emotes.js';
import { shouldRespond, getFallbackResponse } from '../personality.js';
import { metrics as promMetrics, getMetrics } from './utils/metrics.js';
import { getBrain } from './brains/index.js';
import { scoreBrains } from './brains/router.js';
import { enqueueTask, startWorker, drainQueues } from './queue/index.js';
import { jobHandlers } from './queue/handlers.js';
import bus from './bus/index.js';
import { loadPlugins } from './plugins/index.js';
import { ConversationStore } from './memory/conversationStore.js';
import { ProfileStore } from './memory/profileStore.js';
import { MessageQueue } from './queue/messageQueue.js';
import { EventSubClient } from './twitch/eventsub.js';
import { PollinationsClient } from './media/providers.js';
import { writeFile } from 'fs/promises';

const log = createLogger('APP');
const app = express();
const wsInstance = expressWs(app);
app.set('trust proxy', config.server.trustProxy || 1);

let botInitialized = false;
let deepseek = null;
let moderation = null;
let cooldown = new CooldownManager(config.cooldown);
let customCommands = new Map();
let wsClients = new Set();
let server = null;
let workers = [];
let heartbeatInterval = null;
let messageQueue = null;
let eventSubClient = null;
let pollinations = new PollinationsClient();
const publicUrl = config.server.publicUrl || 'http://localhost:3000';

// ---- Auto‑message config ----
const AUTO_ENABLED = config.auto.enabled;
const AUTO_INTERVAL = config.auto.interval * 1000;
const AUTO_USE_DEEPSEEK = config.auto.useDeepSeek;
const AUTO_QUIET_THRESHOLD = config.auto.quietThreshold * 1000;
const AUTO_WELCOME = config.auto.welcome;
const FALLBACK_MESSAGES = [
  "Just vibing in the chat! How's everyone doing?",
  "Anyone else hyped for the next game?",
  "I'm SweatyClanker, your friendly neighborhood bot!",
  "Don't forget to follow if you're enjoying the stream!",
  "What's your favourite game right now?",
  "I'm learning new things every day – thanks for chatting with me!",
  "Feeling lucky today – who's ready for some PogChamp moments?",
];
let fallbackIndex = 0;

// ---- Security ----
app.use(helmet());
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, validate: false });
app.use(limiter);
const allowedOrigins = config.server.allowedOrigins || [];
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && allowedOrigins.length && !allowedOrigins.includes(origin)) {
    return res.status(403).send('Forbidden');
  }
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use('/public', express.static('public'));

// ---- WebSocket for dashboard ----
app.ws('/ws', (ws) => {
  wsClients.add(ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('close', () => wsClients.delete(ws));
});
heartbeatInterval = setInterval(() => {
  for (const ws of wsClients) {
    if (!ws.isAlive) { ws.terminate(); wsClients.delete(ws); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

function broadcast(data) {
  for (const client of wsClients) {
    if (client.readyState === 1) client.send(JSON.stringify(data));
  }
}

// ---- Health ----
app.get('/healthz', (req, res) => res.status(200).send('OK'));
app.get('/livez', (req, res) => res.status(200).send('OK'));
app.get('/readyz', async (req, res) => {
  let attempts = 0;
  while (attempts < 20) {
    const twitchReady = !!global.twitchClient?.connected;
    const redisReady = !!getRedis();
    const deepseekReady = !!deepseek;
    const authReady = isAuthorized();
    if (twitchReady && redisReady && deepseekReady && authReady) {
      return res.status(200).json({ status: 'ready' });
    }
    await new Promise(resolve => setTimeout(resolve, 500));
    attempts++;
  }
  res.status(503).json({
    redis: !!getRedis(),
    twitch: global.twitchClient?.connected || false,
    deepseek: !!deepseek,
    auth: isAuthorized(),
  });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', 'text/plain');
  res.send(await getMetrics());
});

// ---- Auth ----
app.get('/auth/login', (req, res) => {
  const redirectUri = \`\${req.protocol}://\${req.get('host')}/auth/callback\`;
  const url = \`https://id.twitch.tv/oauth2/authorize?client_id=\${config.twitch.clientId}&redirect_uri=\${encodeURIComponent(redirectUri)}&response_type=code&scope=chat:read chat:edit user:bot user:read:chat user:write:chat moderation:read channel:manage:moderators moderator:read:followers moderator:manage:shoutouts\`;
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code');
  try {
    const redirectUri = \`\${req.protocol}://\${req.get('host')}/auth/callback\`;
    await exchangeCodeForToken(code, redirectUri);
    if (!botInitialized) await initializeBot();
    else log.info('Bot already running, skipping re‑initialization');
    res.send('Authorization successful! You may close this window.');
  } catch (err) {
    log.error('Auth callback failed', err);
    res.status(500).send('Authorization failed');
  }
});

app.post('/api/commands', async (req, res) => {
  const { name, response, role } = req.body;
  if (!name || !response) return res.status(400).json({ error: 'Missing fields' });
  await saveCustomCommand(name, response, role || 'all');
  await loadCustomCommandsIntoMemory();
  res.json({ success: true });
});

app.delete('/api/commands/:name', async (req, res) => {
  await deleteCustomCommand(req.params.name);
  await loadCustomCommandsIntoMemory();
  res.json({ success: true });
});

app.post('/api/media/image', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt required' });
  try {
    const result = await pollinations.generateImage(prompt);
    const filename = \`image-\${Date.now()}.png\`;
    await writeFile(\`public/\${filename}\`, result.buffer);
    const url = \`\${publicUrl}/public/\${filename}\`;
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function generateSpontaneousMessage(channel) {
  if (!deepseek || !AUTO_USE_DEEPSEEK) {
    const msg = FALLBACK_MESSAGES[fallbackIndex % FALLBACK_MESSAGES.length];
    fallbackIndex++;
    return msg;
  }
  const systemPrompt = \`You are SweatyClanker, a Twitch chatter. Say something spontaneous, fun, and engaging to the chat. Keep it short.\`;
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: 'Say something random to the chat.' }
  ];
  try {
    const start = Date.now();
    const reply = await deepseek.chat(messages, { temperature: 0.9 });
    promMetrics.aiLatency.observe((Date.now() - start) / 1000);
    promMetrics.aiCalls.inc();
    return reply;
  } catch (err) {
    log.error('Failed to generate spontaneous message', err);
    promMetrics.aiErrors.inc();
    return FALLBACK_MESSAGES[fallbackIndex % FALLBACK_MESSAGES.length];
  }
}

function startAutoMessages() {
  if (!AUTO_ENABLED) return;
  if (global._autoMessageTimer) clearInterval(global._autoMessageTimer);
  global._autoMessageTimer = setInterval(async () => {
    const twitchClient = global.twitchClient;
    if (!twitchClient || !twitchClient.connected) return;
    const now = Date.now();
    for (const channel of twitchClient.channels) {
      const last = await ConversationStore.getLastActivity(channel);
      if (now - last < AUTO_QUIET_THRESHOLD) continue;
      const msg = await generateSpontaneousMessage(channel);
      if (!msg) continue;
      let finalMsg = msg;
      if (config.emotes.enable) {
        const emote = getRandomEmote(channel);
        if (emote) finalMsg += \` \${emote}\`;
      }
      if (messageQueue) messageQueue.enqueue(channel, finalMsg);
      else await twitchClient.say(channel, finalMsg);
      promMetrics.messagesSent.inc();
      await ConversationStore.pushMessage(channel, 'bot', finalMsg);
    }
  }, AUTO_INTERVAL);
  log.info(\`Auto‑messages started (interval: \${AUTO_INTERVAL/1000}s)\`);
}

async function loadCustomCommandsIntoMemory() {
  customCommands = await loadCustomCommands();
}

async function initializeBot() {
  if (botInitialized) {
    log.warn('Bot already initialized, skipping duplicate call');
    return;
  }
  botInitialized = true;
  log.info('Starting bot initialization...');
  if (!isAuthorized()) {
    log.warn('No valid token; bot not starting');
    return;
  }
  log.info('Initializing DeepSeek client...');
  deepseek = new DeepSeekClient();
  log.info('DeepSeek client ready');
  log.info('Initializing moderation...');
  moderation = new Moderation(config.moderation);
  log.info('Loading custom commands...');
  await loadCustomCommandsIntoMemory();
  log.info('Starting BullMQ workers...');
  const queueNames = Object.keys(jobHandlers);
  for (const q of queueNames) {
    const worker = startWorker(q, jobHandlers[q], 1);
    workers.push(worker);
  }
  log.info(\`Task queue workers started for: \${queueNames.join(', ')}\`);
  log.info('Loading plugins...');
  await loadPlugins(bus, config);
  const twitchClient = global.twitchClient;
  if (twitchClient) {
    log.info('Initializing message queue...');
    messageQueue = new MessageQueue(twitchClient);
    log.info('Message queue initialized');
  }
  if (config.eventsub.secret) {
    try {
      log.info('Connecting to EventSub...');
      eventSubClient = new EventSubClient();
      await eventSubClient.connect();
      log.info('EventSub client connected');
    } catch (err) {
      log.warn('EventSub unavailable. Continuing without EventSub.', err.message);
    }
  } else {
    log.info('EventSub secret not set – skipping EventSub');
  }
  bus.on('twitch.message', async (...args) => {
    try { await handleMessage(...args); } catch (err) { log.error('Error in handleMessage', err); }
  });
  bus.on('twitch.usernotice', async (...args) => {
    try { await handleUserNotice(...args); } catch (err) { log.error('Error in handleUserNotice', err); }
  });
  bus.on('twitch.clearchat', async (...args) => {
    try { await handleClearChat(...args); } catch (err) { log.error('Error in handleClearChat', err); }
  });
  bus.on('twitch.send', ({ channel, message }) => {
    try {
      if (messageQueue) messageQueue.enqueue(channel, message);
      else twitchClient?.say(channel, message);
    } catch (err) { log.error('Error in twitch.send handler', err); }
  });
  if (AUTO_WELCOME) {
    bus.on('twitch.join', async (...args) => {
      try { await handleJoin(...args); } catch (err) { log.error('Error in handleJoin', err); }
    });
  }
  bus.on('twitch.ready', () => {
    log.info('Twitch client is ready. Starting auto-messages...');
    startAutoMessages();
  });
  log.info('Bot initialization complete');
  broadcast({ type: 'ready' });
}

async function handleMessage({ channel, user, message, self }) {
  if (self) return;
  promMetrics.messagesReceived.inc();
  const username = user['display-name'] || user.username;
  const login = user.username.toLowerCase();
  await ConversationStore.updateLastActivity(channel);
  if (config.twitch.ignoredUsers.includes(login)) return;
  const modResult = moderation.analyze(channel, user, message);
  if (modResult.blocked) {
    log.warn(\`Blocked message from \${username} in \${channel}\`);
    enqueueTask('moderation-review', { channel, user: username, message, reason: 'rule_blocked' });
    return;
  }
  if (modResult.riskScore > 40) {
    enqueueTask('moderation-review', { channel, user: username, message, riskScore: modResult.riskScore });
  }
  const lowerMsg = message.trim().toLowerCase();
  // Custom commands
  const cmdKey = [...customCommands.keys()].find(cmd => lowerMsg === cmd || lowerMsg.startsWith(cmd + ' '));
  if (cmdKey) {
    const cmd = customCommands.get(cmdKey);
    const hasPermission = cmd.role === 'all' ||
      (cmd.role === 'moderator' && (user.mod || user.badges?.broadcaster)) ||
      (cmd.role === 'broadcaster' && user.badges?.broadcaster);
    if (hasPermission) {
      const cooldownKey = \`\${channel}:\${login}\`;
      if (!cooldown.check(cooldownKey)) {
        log.debug(\`Cooldown active for \${username} in \${channel}\`);
        return;
      }
      const response = typeof cmd.response === 'function' ? cmd.response(message, user) : cmd.response;
      if (messageQueue) messageQueue.enqueue(channel, response);
      else await global.twitchClient.say(channel, response);
      promMetrics.messagesSent.inc();
      return;
    }
  }
  // Built-in commands
  const builtinKey = lowerMsg.split(' ')[0];
  if (builtins.has(builtinKey)) {
    const cmd = builtins.get(builtinKey);
    const cooldownKey = \`\${channel}:\${login}\`;
    if (!cooldown.check(cooldownKey)) return;
    const response = await cmd.handler(user, channel, global.twitchClient, message);
    if (response) {
      if (messageQueue) messageQueue.enqueue(channel, response);
      else await global.twitchClient.say(channel, response);
      promMetrics.messagesSent.inc();
    }
    return;
  }
  // Media generation
  const mediaCommands = {
    [config.media.imageCommand]: { type: 'image', handler: pollinations.generateImage.bind(pollinations) },
    [config.media.videoCommand]: { type: 'video', handler: pollinations.generateVideo.bind(pollinations) },
    [config.media.ttsCommand]: { type: 'tts', handler: pollinations.generateAudio.bind(pollinations) },
    [config.media.musicCommand]: { type: 'music', handler: pollinations.generateMusic.bind(pollinations) },
  };
  for (const [cmd, { type, handler }] of Object.entries(mediaCommands)) {
    if (lowerMsg.startsWith(cmd)) {
      const prompt = message.slice(cmd.length).trim();
      if (!prompt) {
        const response = \`Usage: \${cmd} <description>\`;
        const cooldownKey = \`\${channel}:\${login}\`;
        if (!cooldown.check(cooldownKey)) return;
        if (messageQueue) messageQueue.enqueue(channel, response);
        else await global.twitchClient.say(channel, response);
        return;
      }
      const cooldownKey = \`\${channel}:\${login}\`;
      if (!cooldown.check(cooldownKey)) return;
      try {
        const result = await handler(prompt);
        const ext = type === 'image' ? 'png' : type === 'video' ? 'mp4' : 'mp3';
        const filename = \`media-\${Date.now()}.\${ext}\`;
        await writeFile(\`public/\${filename}\`, result.buffer);
        const url = \`\${publicUrl}/public/\${filename}\`;
        const response = \`Here's your \${type}: \${url}\`;
        if (messageQueue) messageQueue.enqueue(channel, response);
        else await global.twitchClient.say(channel, response);
        promMetrics.messagesSent.inc();
      } catch (err) {
        log.error('Media generation failed', err);
        const response = 'Sorry, media generation failed.';
        if (messageQueue) messageQueue.enqueue(channel, response);
        else await global.twitchClient.say(channel, response);
      }
      return;
    }
  }
  // AI chat
  const shouldReply = shouldRespond(message, config.twitch.username);
  if (!shouldReply) return;
  const cooldownKey = \`\${channel}:\${login}\`;
  if (!cooldown.check(cooldownKey)) return;
  const brainName = await scoreBrains(channel, user, message);
  const Brain = getBrain(brainName);
  const brainConfig = Brain.getConfig();
  const history = await ConversationStore.getHistory(channel, config.deepseek.maxHistory);
  const systemPrompt = brainConfig.systemPrompt;
  const temperature = brainConfig.temperature || 0.7;
  const maxTokens = brainConfig.maxTokens || 1024;
  const userPrompt = buildUserPrompt(message, username, history);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: userPrompt },
  ];
  try {
    const start = Date.now();
    const reply = await deepseek.chat(messages, { temperature, maxTokens });
    const latency = Date.now() - start;
    promMetrics.aiLatency.observe(latency / 1000);
    promMetrics.aiCalls.inc();
    promMetrics.tokenUsage.inc(Math.ceil((userPrompt.length + systemPrompt.length) / 4));
    const processedReply = await Brain.processResponse(reply, { channel, user, message });
    if (brainName === 'moderation') {
      if (processedReply.toxic) {
        log.warn(\`Toxicity detected from \${username}: \${processedReply.reason}\`);
        enqueueTask('moderation-review', { channel, user: username, message, reason: processedReply.reason });
      }
      return;
    }
    let finalReply = processedReply || reply;
    if (!finalReply.trim()) finalReply = getFallbackResponse();
    await ConversationStore.pushMessage(channel, 'user', message, username);
    await ConversationStore.pushMessage(channel, 'assistant', finalReply);
    await ProfileStore.update(channel, login, { lastSeen: Date.now() });
    if (config.emotes.enable) {
      const emote = getRandomEmote(channel);
      if (emote) finalReply += \` \${emote}\`;
    }
    if (messageQueue) messageQueue.enqueue(channel, finalReply);
    else await global.twitchClient.say(channel, finalReply);
    promMetrics.messagesSent.inc();
  } catch (err) {
    log.error('AI chat error', err);
    promMetrics.aiErrors.inc();
    const fallback = getFallbackResponse();
    if (messageQueue) messageQueue.enqueue(channel, fallback);
    else await global.twitchClient.say(channel, fallback);
    promMetrics.messagesSent.inc();
  }
}

async function handleJoin({ channel, username, self }) {
  if (self) return;
  const key = \`\${channel}:\${username}\`;
  if (global._welcomedUsers && global._welcomedUsers.has(key)) return;
  if (!global._welcomedUsers) global._welcomedUsers = new Set();
  const history = await ConversationStore.getHistory(channel, 10);
  const hasSpoken = history.some(h => h.username === username);
  if (hasSpoken) return;
  const welcomeMsg = \`Welcome to the stream, @\${username}! Hope you enjoy the chaos.\`;
  if (messageQueue) messageQueue.enqueue(channel, welcomeMsg);
  else await global.twitchClient.say(channel, welcomeMsg);
  promMetrics.messagesSent.inc();
  global._welcomedUsers.add(key);
  if (global._welcomedUsers.size > 1000) global._welcomedUsers.clear();
}

async function handleUserNotice({ channel, user, msg, tags }) {
  if (tags['msg-id'] === 'raid') {
    const from = tags['display-name'] || 'someone';
    const reply = \`Thanks for the raid, \${from}! PogChamp\`;
    if (messageQueue) messageQueue.enqueue(channel, reply);
    else await global.twitchClient.say(channel, reply);
  } else if (tags['msg-id'] === 'sub' || tags['msg-id'] === 'resub') {
    const subName = tags['display-name'] || 'a viewer';
    const reply = \`Thanks for the sub, \${subName}! Much love <3\`;
    if (messageQueue) messageQueue.enqueue(channel, reply);
    else await global.twitchClient.say(channel, reply);
  }
}

async function handleClearChat({ channel }) {
  log.info(\`Chat cleared in \${channel}\`);
}

app.get('/', (req, res) => {
  res.send(\`<h1>SweatyClanker Bot</h1><p>Status: Running</p><p><a href="/auth/login">Authorize on Twitch</a></p>\`);
});

async function bootstrap() {
  log.info('🚀 Starting SweatyClanker v3...');
  log.info('🔌 Connecting to Redis...');
  await connectRedis();
  const redis = getRedis();
  if (redis) log.info('✅ Redis connected');
  else log.warn('⚠️ Redis not available, using file storage fallback');
  log.info('🔐 Initializing authentication...');
  await initAuth();
  const authorized = isAuthorized();
  if (authorized) log.info('✅ Token found and validated');
  else log.info('ℹ️ No token yet – waiting for OAuth');
  log.info('📦 Loading emotes...');
  const emotePools = await initializeEmotes(config.twitch.channels);
  setEmotePools(emotePools);
  log.info('✅ Emotes loaded');
  if (authorized && !botInitialized) {
    await initializeBot();
  } else if (!authorized) {
    log.info('No token, waiting for auth');
  }
  const port = config.server.port;
  server = app.listen(port, () => {
    log.info(\`🌐 Server running on port \${port}\`);
  });
}

async function shutdown() {
  log.info('Shutting down gracefully...');
  if (global._autoMessageTimer) clearInterval(global._autoMessageTimer);
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  if (messageQueue) messageQueue.stop();
  if (eventSubClient) eventSubClient.disconnect();
  await drainQueues();
  if (global.twitchClient) global.twitchClient.disconnect();
  const redis = getRedis();
  if (redis) await redis.quit();
  if (server) {
    await new Promise(resolve => {
      server.close(() => { log.info('HTTP server closed'); resolve(); });
      setTimeout(() => { log.warn('Forcing server close'); resolve(); }, 5000);
    });
  }
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', (err) => {
  log.error('Uncaught Exception', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  log.error('Unhandled Rejection', err);
  process.exit(1);
});

bootstrap().catch(err => {
  log.error('Bootstrap failed', err);
  process.exit(1);
});
`,

  "personality.js": "// ============================================================\n// PERSONALITY — response triggers + fallback lines\n// ============================================================\nconst FALLBACKS = [\n  \"Hmm, my brain glitched for a sec — say that again?\",\n  \"Lost my train of thought, chat. What's up?\",\n  \"404: witty reply not found. Try me again!\",\n];\n\nexport function shouldRespond(message, botUsername) {\n  const lower = message.toLowerCase();\n  const nameLower = (botUsername || '').toLowerCase();\n  if (nameLower && lower.includes(nameLower)) return true;\n  if (lower.startsWith('@') && nameLower && lower.startsWith(`@${nameLower}`)) return true;\n  if (lower.includes('sweatyclanker')) return true;\n  return false;\n}\n\nexport function getFallbackResponse() {\n  return FALLBACKS[Math.floor(Math.random() * FALLBACKS.length)];\n}\n",
  "src/ai/client.js": "// ============================================================\n// DEEPSEEK CLIENT — OpenAI-compatible chat completions\n// ============================================================\nimport { config } from '../config/index.js';\nimport { createLogger } from '../logger/index.js';\n\nconst log = createLogger('DEEPSEEK');\nconst API_URL = 'https://api.deepseek.com/v1/chat/completions';\n\nexport class DeepSeekClient {\n  constructor() {\n    this.apiKey = config.deepseek.apiKey;\n    this.model = config.deepseek.model;\n    this.timeoutMs = config.deepseek.timeoutMs;\n    this.maxRetries = config.deepseek.maxRetries;\n    this.circuitThreshold = config.deepseek.circuitBreakerThreshold;\n    this.failureCount = 0;\n    this.circuitOpenUntil = 0;\n  }\n\n  circuitOpen() {\n    return Date.now() < this.circuitOpenUntil;\n  }\n\n  recordFailure() {\n    this.failureCount++;\n    if (this.failureCount >= this.circuitThreshold) {\n      this.circuitOpenUntil = Date.now() + 30000;\n      log.warn('Circuit breaker opened — pausing DeepSeek calls for 30s');\n    }\n  }\n\n  recordSuccess() {\n    this.failureCount = 0;\n  }\n\n  async chat(messages, opts = {}) {\n    if (this.circuitOpen()) {\n      throw new Error('DeepSeek circuit breaker is open');\n    }\n    const temperature = opts.temperature ?? config.deepseek.temperature;\n    const maxTokens = opts.maxTokens ?? config.deepseek.maxTokens;\n\n    let lastErr;\n    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {\n      const controller = new AbortController();\n      const timer = setTimeout(() => controller.abort(), this.timeoutMs);\n      try {\n        const res = await fetch(API_URL, {\n          method: 'POST',\n          headers: {\n            'Content-Type': 'application/json',\n            Authorization: `Bearer ${this.apiKey}`,\n          },\n          body: JSON.stringify({\n            model: this.model,\n            messages,\n            temperature,\n            max_tokens: maxTokens,\n          }),\n          signal: controller.signal,\n        });\n        clearTimeout(timer);\n        if (!res.ok) {\n          const text = await res.text();\n          throw new Error(`DeepSeek API error ${res.status}: ${text}`);\n        }\n        const data = await res.json();\n        const reply = data.choices?.[0]?.message?.content?.trim();\n        if (!reply) throw new Error('Empty response from DeepSeek');\n        this.recordSuccess();\n        return reply;\n      } catch (err) {\n        clearTimeout(timer);\n        lastErr = err;\n        log.warn(`DeepSeek attempt ${attempt + 1}/${this.maxRetries + 1} failed: ${err.message}`);\n        if (attempt < this.maxRetries) {\n          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));\n        }\n      }\n    }\n    this.recordFailure();\n    throw lastErr;\n  }\n}\n",
  "src/ai/prompt.js": "// ============================================================\n// PROMPT BUILDING\n// ============================================================\nexport function buildUserPrompt(message, username, history = []) {\n  return `${username} says: ${message}`;\n}\n",
  "src/brains/index.js": "// ============================================================\n// BRAINS — pluggable response personalities\n// ============================================================\nconst brains = {\n  default: {\n    getConfig: () => ({\n      systemPrompt:\n        'You are SweatyClanker, a witty, high-energy Twitch chat bot. Keep replies short (1-2 sentences), fun, and in the spirit of Twitch chat culture. Never be hateful or explicit.',\n      temperature: 0.7,\n      maxTokens: 1024,\n    }),\n    processResponse: async (reply) => reply,\n  },\n  moderation: {\n    getConfig: () => ({\n      systemPrompt:\n        'You are a content moderation classifier. Respond ONLY with JSON: {\"toxic\": boolean, \"reason\": string}.',\n      temperature: 0,\n      maxTokens: 128,\n    }),\n    processResponse: async (reply) => {\n      try {\n        return JSON.parse(reply);\n      } catch {\n        return { toxic: false, reason: 'unparsable' };\n      }\n    },\n  },\n};\n\nexport function getBrain(name) {\n  return brains[name] || brains.default;\n}\n",
  "src/brains/router.js": "// ============================================================\n// BRAIN ROUTER — decides which brain should handle a message\n// ============================================================\nexport async function scoreBrains(channel, user, message) {\n  // Simple default routing; extend with real scoring/heuristics later.\n  return 'default';\n}\n",
  "src/bus/index.js": "// ============================================================\n// EVENT BUS — shared EventEmitter used across the app\n// ============================================================\nimport { EventEmitter } from 'events';\n\nclass Bus extends EventEmitter {}\n\nconst bus = new Bus();\nbus.setMaxListeners(50);\n\nexport default bus;\n",
  "src/commands/builtins.js": "// ============================================================\n// BUILT-IN COMMANDS — registers into the `builtins` map on import\n// ============================================================\nimport { builtins } from './index.js';\n\nconst startedAt = Date.now();\n\nbuiltins.set('!uptime', {\n  handler: async () => {\n    const seconds = Math.floor((Date.now() - startedAt) / 1000);\n    const h = Math.floor(seconds / 3600);\n    const m = Math.floor((seconds % 3600) / 60);\n    const s = seconds % 60;\n    return `Bot uptime: ${h}h ${m}m ${s}s`;\n  },\n});\n\nbuiltins.set('!help', {\n  handler: async () => 'Commands: !help, !uptime, !commands, !image <prompt>, !video <prompt>, !tts <text>, !song <prompt>',\n});\n\nbuiltins.set('!commands', {\n  handler: async () => `Built-ins: ${[...builtins.keys()].join(', ')}`,\n});\n\nbuiltins.set('!ping', {\n  handler: async () => 'Pong!',\n});\n",
  "src/commands/index.js": "// ============================================================\n// COMMANDS — built-in registry + custom command persistence\n// ============================================================\nimport fs from 'fs/promises';\nimport path from 'path';\nimport { getRedis } from '../storage/redis.js';\nimport { createLogger } from '../logger/index.js';\n\nconst log = createLogger('COMMANDS');\nconst CUSTOM_COMMANDS_PATH = path.resolve('custom_commands.txt');\nconst REDIS_KEY = 'sweatyclanker:custom_commands';\n\n// name -> { handler(user, channel, client, message) }\nexport const builtins = new Map();\n\nasync function readFileStore() {\n  try {\n    const raw = await fs.readFile(CUSTOM_COMMANDS_PATH, 'utf8');\n    return JSON.parse(raw);\n  } catch {\n    return {};\n  }\n}\n\nasync function writeFileStore(data) {\n  await fs.writeFile(CUSTOM_COMMANDS_PATH, JSON.stringify(data, null, 2), 'utf8');\n}\n\nexport async function loadCustomCommands() {\n  const redis = getRedis();\n  let data = {};\n  if (redis) {\n    const raw = await redis.get(REDIS_KEY);\n    data = raw ? JSON.parse(raw) : {};\n  } else {\n    data = await readFileStore();\n  }\n  const map = new Map();\n  for (const [name, value] of Object.entries(data)) {\n    map.set(name.toLowerCase(), value);\n  }\n  log.info(`Loaded ${map.size} custom commands`);\n  return map;\n}\n\nexport async function saveCustomCommand(name, response, role = 'all') {\n  const key = name.toLowerCase();\n  const redis = getRedis();\n  if (redis) {\n    const raw = await redis.get(REDIS_KEY);\n    const data = raw ? JSON.parse(raw) : {};\n    data[key] = { response, role };\n    await redis.set(REDIS_KEY, JSON.stringify(data));\n  } else {\n    const data = await readFileStore();\n    data[key] = { response, role };\n    await writeFileStore(data);\n  }\n  log.info(`Saved custom command: ${key}`);\n}\n\nexport async function deleteCustomCommand(name) {\n  const key = name.toLowerCase();\n  const redis = getRedis();\n  if (redis) {\n    const raw = await redis.get(REDIS_KEY);\n    const data = raw ? JSON.parse(raw) : {};\n    delete data[key];\n    await redis.set(REDIS_KEY, JSON.stringify(data));\n  } else {\n    const data = await readFileStore();\n    delete data[key];\n    await writeFileStore(data);\n  }\n  log.info(`Deleted custom command: ${key}`);\n}\n",
  "src/logger/index.js": "// ============================================================\n// LOGGER\n// ============================================================\nconst LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };\nconst currentLevel = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;\n\nfunction ts() {\n  return new Date().toISOString();\n}\n\nfunction fmt(label, level, args) {\n  return [`[${ts()}] [${level.toUpperCase()}] [${label}]`, ...args];\n}\n\nexport function createLogger(label) {\n  return {\n    error: (...args) => { if (currentLevel >= LEVELS.error) console.error(...fmt(label, 'error', args)); },\n    warn: (...args) => { if (currentLevel >= LEVELS.warn) console.warn(...fmt(label, 'warn', args)); },\n    info: (...args) => { if (currentLevel >= LEVELS.info) console.log(...fmt(label, 'info', args)); },\n    debug: (...args) => { if (currentLevel >= LEVELS.debug) console.log(...fmt(label, 'debug', args)); },\n  };\n}\n\nexport const logger = createLogger('APP');\n",
  "src/media/providers.js": "// ============================================================\n// MEDIA PROVIDERS — Pollinations.ai image / audio generation\n// ============================================================\nimport { createLogger } from '../logger/index.js';\n\nconst log = createLogger('MEDIA');\n\nasync function fetchBuffer(url) {\n  const res = await fetch(url);\n  if (!res.ok) throw new Error(`Media request failed: ${res.status}`);\n  const arrayBuffer = await res.arrayBuffer();\n  return Buffer.from(arrayBuffer);\n}\n\nexport class PollinationsClient {\n  async generateImage(prompt) {\n    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}`;\n    log.debug(`Generating image for prompt: ${prompt}`);\n    const buffer = await fetchBuffer(url);\n    return { buffer, mime: 'image/png' };\n  }\n\n  async generateVideo(prompt) {\n    // Pollinations does not currently offer a stable public video endpoint;\n    // this is a placeholder that throws a clear error until one is wired up.\n    throw new Error('Video generation is not yet supported by the configured provider');\n  }\n\n  async generateAudio(text) {\n    const url = `https://text.pollinations.ai/${encodeURIComponent(text)}?model=openai-audio`;\n    log.debug(`Generating TTS for text: ${text.slice(0, 60)}...`);\n    const buffer = await fetchBuffer(url);\n    return { buffer, mime: 'audio/mpeg' };\n  }\n\n  async generateMusic(prompt) {\n    // No dedicated music endpoint publicly available yet — reuse audio TTS\n    // as a stopgap so the command doesn't hard-crash.\n    throw new Error('Music generation is not yet supported by the configured provider');\n  }\n}\n",
  "src/memory/conversationStore.js": "// ============================================================\n// CONVERSATION STORE — per-channel chat history + last-activity\n// Uses Redis when available, falls back to in-memory Maps.\n// ============================================================\nimport { getRedis } from '../storage/redis.js';\n\nconst memHistory = new Map(); // channel -> [{role, content, username?}]\nconst memActivity = new Map(); // channel -> timestamp\nconst MAX_STORED = 50;\n\nfunction historyKey(channel) {\n  return `sweatyclanker:history:${channel}`;\n}\nfunction activityKey(channel) {\n  return `sweatyclanker:activity:${channel}`;\n}\n\nexport const ConversationStore = {\n  async pushMessage(channel, role, content, username = null) {\n    const entry = { role, content, username, ts: Date.now() };\n    const redis = getRedis();\n    if (redis) {\n      await redis.rpush(historyKey(channel), JSON.stringify(entry));\n      await redis.ltrim(historyKey(channel), -MAX_STORED, -1);\n    } else {\n      if (!memHistory.has(channel)) memHistory.set(channel, []);\n      const arr = memHistory.get(channel);\n      arr.push(entry);\n      if (arr.length > MAX_STORED) arr.shift();\n    }\n  },\n\n  async getHistory(channel, limit = 5) {\n    const redis = getRedis();\n    if (redis) {\n      const raw = await redis.lrange(historyKey(channel), -limit, -1);\n      return raw.map((r) => JSON.parse(r));\n    }\n    const arr = memHistory.get(channel) || [];\n    return arr.slice(-limit);\n  },\n\n  async updateLastActivity(channel) {\n    const now = Date.now();\n    const redis = getRedis();\n    if (redis) {\n      await redis.set(activityKey(channel), String(now));\n    } else {\n      memActivity.set(channel, now);\n    }\n  },\n\n  async getLastActivity(channel) {\n    const redis = getRedis();\n    if (redis) {\n      const val = await redis.get(activityKey(channel));\n      return val ? Number(val) : 0;\n    }\n    return memActivity.get(channel) || 0;\n  },\n};\n",
  "src/memory/profileStore.js": "// ============================================================\n// PROFILE STORE — lightweight per-user, per-channel profile data\n// ============================================================\nimport { getRedis } from '../storage/redis.js';\n\nconst memProfiles = new Map(); // `${channel}:${login}` -> object\n\nfunction key(channel, login) {\n  return `sweatyclanker:profile:${channel}:${login}`;\n}\n\nexport const ProfileStore = {\n  async update(channel, login, patch) {\n    const redis = getRedis();\n    if (redis) {\n      const raw = await redis.get(key(channel, login));\n      const current = raw ? JSON.parse(raw) : {};\n      const updated = { ...current, ...patch };\n      await redis.set(key(channel, login), JSON.stringify(updated));\n      return updated;\n    }\n    const k = `${channel}:${login}`;\n    const current = memProfiles.get(k) || {};\n    const updated = { ...current, ...patch };\n    memProfiles.set(k, updated);\n    return updated;\n  },\n\n  async get(channel, login) {\n    const redis = getRedis();\n    if (redis) {\n      const raw = await redis.get(key(channel, login));\n      return raw ? JSON.parse(raw) : null;\n    }\n    return memProfiles.get(`${channel}:${login}`) || null;\n  },\n};\n",
  "src/moderation/index.js": "// ============================================================\n// MODERATION — spam / caps / link / repeat-message filtering\n// ============================================================\nimport { createLogger } from '../logger/index.js';\n\nconst log = createLogger('MODERATION');\nconst LINK_REGEX = /(https?:\\/\\/|www\\.)\\S+/i;\n\nexport class Moderation {\n  constructor(opts = {}) {\n    this.maxRepeats = opts.maxRepeats ?? 3;\n    this.maxCapsRatio = opts.maxCapsRatio ?? 0.7;\n    this.linkFilter = opts.linkFilter ?? false; // ALLOW_LINKS\n    this.recentByUser = new Map(); // `${channel}:${user}` -> { last, count }\n  }\n\n  capsRatio(message) {\n    const letters = message.replace(/[^a-zA-Z]/g, '');\n    if (!letters.length) return 0;\n    const caps = letters.replace(/[^A-Z]/g, '');\n    return caps.length / letters.length;\n  }\n\n  analyze(channel, user, message) {\n    const login = (user.username || '').toLowerCase();\n    const key = `${channel}:${login}`;\n    const now = Date.now();\n    const prev = this.recentByUser.get(key);\n\n    let repeatCount = 1;\n    if (prev && prev.last === message) {\n      repeatCount = (prev.count || 1) + 1;\n    }\n    this.recentByUser.set(key, { last: message, count: repeatCount, ts: now });\n\n    let riskScore = 0;\n    const reasons = [];\n\n    if (repeatCount > this.maxRepeats) {\n      riskScore += 30;\n      reasons.push('repeated_message');\n    }\n\n    if (message.length > 10 && this.capsRatio(message) > this.maxCapsRatio) {\n      riskScore += 20;\n      reasons.push('excessive_caps');\n    }\n\n    if (!this.linkFilter && LINK_REGEX.test(message)) {\n      riskScore += 25;\n      reasons.push('link_posted');\n    }\n\n    const blocked = repeatCount > this.maxRepeats * 2;\n    if (blocked) log.debug(`Blocking message from ${login}: ${reasons.join(',')}`);\n\n    return { blocked, riskScore, reasons };\n  }\n}\n",
  "src/plugins/index.js": "// ============================================================\n// PLUGINS — loads *.js files from ./plugins-enabled (optional dir)\n// Each plugin exports a default function: (bus, config) => void\n// ============================================================\nimport fs from 'fs/promises';\nimport path from 'path';\nimport { pathToFileURL } from 'url';\nimport { createLogger } from '../logger/index.js';\n\nconst log = createLogger('PLUGINS');\nconst PLUGINS_DIR = path.resolve('plugins-enabled');\n\nexport async function loadPlugins(bus, config) {\n  let entries;\n  try {\n    entries = await fs.readdir(PLUGINS_DIR);\n  } catch {\n    log.info('No plugins-enabled/ directory found — skipping plugin load');\n    return;\n  }\n  const jsFiles = entries.filter((f) => f.endsWith('.js'));\n  for (const file of jsFiles) {\n    try {\n      const mod = await import(pathToFileURL(path.join(PLUGINS_DIR, file)).href);\n      if (typeof mod.default === 'function') {\n        await mod.default(bus, config);\n        log.info(`Loaded plugin: ${file}`);\n      } else {\n        log.warn(`Plugin ${file} has no default export function — skipped`);\n      }\n    } catch (err) {\n      log.error(`Failed to load plugin ${file}`, err.message);\n    }\n  }\n}\n",
  "src/queue/handlers.js": "// ============================================================\n// JOB HANDLERS — one per queue name registered via startWorker()\n// ============================================================\nimport { createLogger } from '../logger/index.js';\n\nconst log = createLogger('JOBS');\n\nexport const jobHandlers = {\n  'moderation-review': async (job) => {\n    const { channel, user, message, reason, riskScore } = job.data;\n    log.info(\n      `Moderation review — channel=${channel} user=${user} reason=${reason || 'n/a'} riskScore=${riskScore ?? 'n/a'}: \"${message}\"`\n    );\n  },\n};\n",
  "src/queue/index.js": "// ============================================================\n// QUEUE — BullMQ-backed task queue, with an in-memory fallback\n// when no Redis connection is configured\n// ============================================================\nimport { Queue, Worker } from 'bullmq';\nimport { config } from '../config/index.js';\nimport { createLogger } from '../logger/index.js';\n\nconst log = createLogger('QUEUE');\nconst useRedis = !!config.redis.url;\nconst connection = useRedis ? { url: config.redis.url } : null;\n\nconst queues = new Map(); // name -> Queue\nconst workers = [];\nconst fallbackHandlers = new Map(); // name -> handler(job)\n\nfunction getQueue(name) {\n  if (!useRedis) return null;\n  if (!queues.has(name)) {\n    queues.set(name, new Queue(name, { connection }));\n  }\n  return queues.get(name);\n}\n\nexport async function enqueueTask(name, data) {\n  if (useRedis) {\n    const queue = getQueue(name);\n    await queue.add(name, data, { removeOnComplete: 100, removeOnFail: 100 });\n  } else {\n    // Fallback: run immediately in-process, best-effort\n    const handler = fallbackHandlers.get(name);\n    if (handler) {\n      Promise.resolve(handler({ data })).catch((err) =>\n        log.error(`Fallback job \"${name}\" failed`, err.message)\n      );\n    } else {\n      log.warn(`No Redis and no fallback handler registered for task \"${name}\" — dropped`);\n    }\n  }\n}\n\nexport function startWorker(name, handler, concurrency = 1) {\n  fallbackHandlers.set(name, handler);\n  if (!useRedis) {\n    log.info(`Queue \"${name}\" running in-memory fallback mode (no Redis)`);\n    return null;\n  }\n  const worker = new Worker(name, handler, { connection, concurrency });\n  worker.on('failed', (job, err) => log.error(`Job failed in \"${name}\"`, err.message));\n  workers.push(worker);\n  log.info(`Worker started for queue \"${name}\"`);\n  return worker;\n}\n\nexport async function drainQueues() {\n  for (const worker of workers) {\n    await worker.close();\n  }\n  for (const queue of queues.values()) {\n    await queue.close();\n  }\n}\n",
  "src/queue/messageQueue.js": "// ============================================================\n// MESSAGE QUEUE — rate-limits outbound chat messages per channel\n// (Twitch allows ~20 msgs / 30s for regular bots)\n// ============================================================\nimport { createLogger } from '../logger/index.js';\n\nconst log = createLogger('MSG-QUEUE');\nconst SEND_INTERVAL_MS = 1500;\n\nexport class MessageQueue {\n  constructor(twitchClient) {\n    this.client = twitchClient;\n    this.queues = new Map(); // channel -> string[]\n    this.timers = new Map();\n    this.stopped = false;\n  }\n\n  enqueue(channel, message) {\n    if (this.stopped) return;\n    if (!this.queues.has(channel)) this.queues.set(channel, []);\n    this.queues.get(channel).push(message);\n    this.ensureProcessing(channel);\n  }\n\n  ensureProcessing(channel) {\n    if (this.timers.has(channel)) return;\n    const tick = async () => {\n      const queue = this.queues.get(channel) || [];\n      const next = queue.shift();\n      if (next) {\n        try {\n          await this.client.say(channel, next);\n        } catch (err) {\n          log.error(`Failed to send message to ${channel}`, err.message);\n        }\n      }\n      if (queue.length && !this.stopped) {\n        this.timers.set(channel, setTimeout(tick, SEND_INTERVAL_MS));\n      } else {\n        this.timers.delete(channel);\n      }\n    };\n    this.timers.set(channel, setTimeout(tick, 0));\n  }\n\n  stop() {\n    this.stopped = true;\n    for (const timer of this.timers.values()) clearTimeout(timer);\n    this.timers.clear();\n    this.queues.clear();\n  }\n}\n",
  "src/storage/redis.js": "// ============================================================\n// REDIS STORAGE (optional — bot runs without it, using in-memory\n// fallbacks in the memory/ and commands/ modules)\n// ============================================================\nimport Redis from 'ioredis';\nimport { config } from '../config/index.js';\nimport { createLogger } from '../logger/index.js';\n\nconst log = createLogger('REDIS');\nlet client = null;\n\nexport async function connectRedis() {\n  const url = config.redis.url;\n  if (!url) {\n    log.warn('No REDIS_URL configured — running with in-memory storage only');\n    return null;\n  }\n  try {\n    client = new Redis(url, {\n      maxRetriesPerRequest: 3,\n      lazyConnect: true,\n      reconnectOnError: () => true,\n    });\n    client.on('error', (err) => log.error('Redis error', err.message));\n    client.on('connect', () => log.info('Redis connected'));\n    await client.connect();\n    return client;\n  } catch (err) {\n    log.error('Failed to connect to Redis, falling back to in-memory storage', err.message);\n    client = null;\n    return null;\n  }\n}\n\nexport function getRedis() {\n  return client;\n}\n",
  "src/twitch/auth.js": "// ============================================================\n// TWITCH AUTH — OAuth token exchange, storage, and refresh\n// ============================================================\nimport fs from 'fs/promises';\nimport path from 'path';\nimport { config } from '../config/index.js';\nimport { createLogger } from '../logger/index.js';\nimport { createTwitchClient } from './client.js';\n\nconst log = createLogger('AUTH');\nconst TOKENS_PATH = path.resolve('tokens.json');\n\nlet tokens = null; // { access_token, refresh_token, expires_at }\n\nasync function loadTokens() {\n  try {\n    const raw = await fs.readFile(TOKENS_PATH, 'utf8');\n    tokens = JSON.parse(raw);\n    return tokens;\n  } catch {\n    return null;\n  }\n}\n\nasync function saveTokens(t) {\n  tokens = t;\n  await fs.writeFile(TOKENS_PATH, JSON.stringify(t, null, 2), 'utf8');\n}\n\nexport async function initAuth() {\n  await loadTokens();\n  if (tokens?.access_token) {\n    log.info('Loaded existing tokens from disk');\n    // Fire off client creation; auth.js owns the singleton twitch client\n    await createTwitchClient(tokens.access_token);\n  }\n}\n\nexport function isAuthorized() {\n  return !!tokens?.access_token;\n}\n\nexport async function exchangeCodeForToken(code, redirectUri) {\n  const params = new URLSearchParams({\n    client_id: config.twitch.clientId,\n    client_secret: config.twitch.clientSecret,\n    code,\n    grant_type: 'authorization_code',\n    redirect_uri: redirectUri,\n  });\n  const res = await fetch('https://id.twitch.tv/oauth2/token', {\n    method: 'POST',\n    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },\n    body: params.toString(),\n  });\n  if (!res.ok) {\n    const text = await res.text();\n    throw new Error(`Token exchange failed: ${res.status} ${text}`);\n  }\n  const data = await res.json();\n  const expiresAt = Date.now() + (data.expires_in || 0) * 1000;\n  await saveTokens({\n    access_token: data.access_token,\n    refresh_token: data.refresh_token,\n    expires_at: expiresAt,\n  });\n  log.info('Token exchange successful');\n  await createTwitchClient(data.access_token);\n  return tokens;\n}\n\nexport async function refreshAccessToken() {\n  if (!tokens?.refresh_token) throw new Error('No refresh token available');\n  const params = new URLSearchParams({\n    client_id: config.twitch.clientId,\n    client_secret: config.twitch.clientSecret,\n    grant_type: 'refresh_token',\n    refresh_token: tokens.refresh_token,\n  });\n  const res = await fetch('https://id.twitch.tv/oauth2/token', {\n    method: 'POST',\n    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },\n    body: params.toString(),\n  });\n  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);\n  const data = await res.json();\n  const expiresAt = Date.now() + (data.expires_in || 0) * 1000;\n  await saveTokens({\n    access_token: data.access_token,\n    refresh_token: data.refresh_token || tokens.refresh_token,\n    expires_at: expiresAt,\n  });\n  log.info('Token refreshed');\n  return tokens;\n}\n\nexport function getAccessToken() {\n  return tokens?.access_token || null;\n}\n",
  "src/twitch/client.js": "// ============================================================\n// TWITCH CHAT CLIENT — wraps tmi.js and publishes events on the bus\n// ============================================================\nimport tmi from 'tmi.js';\nimport { config } from '../config/index.js';\nimport { createLogger } from '../logger/index.js';\nimport bus from '../bus/index.js';\n\nconst log = createLogger('TWITCH-CLIENT');\n\nexport async function createTwitchClient(oauthToken) {\n  if (global.twitchClient) {\n    log.warn('Twitch client already exists — skipping re-creation');\n    return global.twitchClient;\n  }\n\n  const client = new tmi.Client({\n    options: { debug: false },\n    connection: { reconnect: true, secure: true },\n    identity: {\n      username: config.twitch.username,\n      password: `oauth:${oauthToken.replace(/^oauth:/, '')}`,\n    },\n    channels: config.twitch.channels,\n  });\n\n  client.connected = false;\n\n  client.on('connected', () => {\n    client.connected = true;\n    log.info(`Connected to Twitch as ${config.twitch.username}`);\n    bus.emit('twitch.ready');\n  });\n\n  client.on('disconnected', (reason) => {\n    client.connected = false;\n    log.warn('Disconnected from Twitch:', reason);\n  });\n\n  client.on('message', (channel, tags, message, self) => {\n    bus.emit('twitch.message', {\n      channel,\n      user: tags,\n      message,\n      self,\n    });\n  });\n\n  client.on('usernotice', (channel, tags, message) => {\n    bus.emit('twitch.usernotice', { channel, user: tags, msg: message, tags });\n  });\n\n  client.on('clearchat', (channel) => {\n    bus.emit('twitch.clearchat', { channel });\n  });\n\n  client.on('join', (channel, username, self) => {\n    bus.emit('twitch.join', { channel, username, self });\n  });\n\n  await client.connect();\n  global.twitchClient = client;\n  return client;\n}\n",
  "src/twitch/emotes.js": "// ============================================================\n// EMOTES — loads 7TV / BTTV / FFZ global + channel emotes\n// ============================================================\nimport { config } from '../config/index.js';\nimport { createLogger } from '../logger/index.js';\n\nconst log = createLogger('EMOTES');\nlet pools = {}; // channel -> string[]\n\nasync function safeFetchJson(url) {\n  try {\n    const res = await fetch(url);\n    if (!res.ok) return null;\n    return await res.json();\n  } catch (err) {\n    log.warn(`Emote fetch failed for ${url}: ${err.message}`);\n    return null;\n  }\n}\n\nasync function load7tv(channelLogin) {\n  if (!config.emotes.sevenTv) return [];\n  const data = await safeFetchJson(`https://7tv.io/v3/users/twitch/${channelLogin}`);\n  const set = data?.emote_set?.emotes || [];\n  return set.map((e) => e.name);\n}\n\nasync function loadBttv(channelLogin) {\n  if (!config.emotes.bttv) return [];\n  // Global emotes\n  const global = (await safeFetchJson('https://api.betterttv.net/3/cached/emotes/global')) || [];\n  const names = global.map((e) => e.code);\n  return names;\n}\n\nasync function loadFfz(channelLogin) {\n  if (!config.emotes.ffz) return [];\n  const data = await safeFetchJson(`https://api.frankerfacez.com/v1/room/${channelLogin}`);\n  if (!data?.sets) return [];\n  const names = [];\n  for (const set of Object.values(data.sets)) {\n    for (const e of set.emoticons || []) names.push(e.name);\n  }\n  return names;\n}\n\nexport async function initializeEmotes(channels) {\n  const result = {};\n  for (const channel of channels) {\n    const login = channel.replace(/^#/, '');\n    const [sevenTv, bttv, ffz] = await Promise.all([\n      load7tv(login),\n      loadBttv(login),\n      loadFfz(login),\n    ]);\n    const all = [...sevenTv, ...bttv, ...ffz];\n    result[channel] = all.length ? all : [];\n    log.info(`Loaded ${all.length} emotes for ${channel}`);\n  }\n  pools = result;\n  return result;\n}\n\nexport function setEmotePools(newPools) {\n  pools = newPools || {};\n}\n\nexport function getRandomEmote(channel) {\n  const list = pools[channel] || pools[`#${channel}`.replace('##', '#')];\n  if (!list || !list.length) return null;\n  return list[Math.floor(Math.random() * list.length)];\n}\n",
  "src/twitch/eventsub.js": "// ============================================================\n// EVENTSUB — WebSocket connection to Twitch EventSub\n// (subscription registration is left as a TODO per-event-type;\n// this establishes and maintains the socket connection safely)\n// ============================================================\nimport WebSocket from 'ws';\nimport { config } from '../config/index.js';\nimport { createLogger } from '../logger/index.js';\nimport bus from '../bus/index.js';\n\nconst log = createLogger('EVENTSUB');\n\nexport class EventSubClient {\n  constructor() {\n    this.ws = null;\n    this.sessionId = null;\n    this.reconnectAttempts = 0;\n    this.closedByUs = false;\n  }\n\n  async connect(url = config.eventsub.wssUrl) {\n    return new Promise((resolve, reject) => {\n      this.ws = new WebSocket(url);\n      let resolved = false;\n\n      this.ws.on('open', () => {\n        log.info('EventSub WebSocket opened');\n      });\n\n      this.ws.on('message', (data) => {\n        try {\n          const msg = JSON.parse(data.toString());\n          const type = msg.metadata?.message_type;\n          if (type === 'session_welcome') {\n            this.sessionId = msg.payload.session.id;\n            log.info(`EventSub session established: ${this.sessionId}`);\n            this.reconnectAttempts = 0;\n            if (!resolved) { resolved = true; resolve(); }\n          } else if (type === 'session_keepalive') {\n            // no-op\n          } else if (type === 'session_reconnect') {\n            const newUrl = msg.payload.session.reconnect_url;\n            log.warn('EventSub requested reconnect');\n            this.reconnect(newUrl);\n          } else if (type === 'notification') {\n            bus.emit('twitch.eventsub', msg.payload);\n          } else if (type === 'revocation') {\n            log.warn('EventSub subscription revoked', msg.payload?.subscription?.type);\n          }\n        } catch (err) {\n          log.error('Failed to parse EventSub message', err.message);\n        }\n      });\n\n      this.ws.on('close', () => {\n        log.warn('EventSub WebSocket closed');\n        if (!this.closedByUs) this.scheduleReconnect();\n      });\n\n      this.ws.on('error', (err) => {\n        log.error('EventSub WebSocket error', err.message);\n        if (!resolved) { resolved = true; reject(err); }\n      });\n    });\n  }\n\n  scheduleReconnect() {\n    this.reconnectAttempts++;\n    const delay = Math.min(30000, 1000 * 2 ** this.reconnectAttempts);\n    log.info(`Reconnecting EventSub in ${delay}ms`);\n    setTimeout(() => this.connect().catch(() => {}), delay);\n  }\n\n  async reconnect(url) {\n    try {\n      if (this.ws) { this.closedByUs = true; this.ws.close(); this.closedByUs = false; }\n      await this.connect(url);\n    } catch (err) {\n      log.error('EventSub reconnect failed', err.message);\n    }\n  }\n\n  disconnect() {\n    this.closedByUs = true;\n    if (this.ws) this.ws.close();\n  }\n}\n",
  "src/utils/cooldown.js": "// ============================================================\n// COOLDOWN MANAGER — global + per-user cooldowns\n// ============================================================\nexport class CooldownManager {\n  constructor(opts = {}) {\n    this.globalMs = (opts.global ?? 1) * 1000;\n    this.perUserMs = (opts.perUser ?? 5) * 1000;\n    this.lastGlobal = 0;\n    this.lastByKey = new Map();\n  }\n\n  check(key) {\n    const now = Date.now();\n    if (now - this.lastGlobal < this.globalMs) return false;\n    const lastUser = this.lastByKey.get(key) || 0;\n    if (now - lastUser < this.perUserMs) return false;\n    this.lastGlobal = now;\n    this.lastByKey.set(key, now);\n    if (this.lastByKey.size > 5000) this.lastByKey.clear();\n    return true;\n  }\n}\n",
  "src/utils/metrics.js": "// ============================================================\n// METRICS — prom-client counters/histograms + /metrics endpoint\n// ============================================================\nimport client from 'prom-client';\n\nconst register = new client.Registry();\nclient.collectDefaultMetrics({ register });\n\nconst messagesReceived = new client.Counter({\n  name: 'sweatyclanker_messages_received_total',\n  help: 'Total chat messages received',\n});\nconst messagesSent = new client.Counter({\n  name: 'sweatyclanker_messages_sent_total',\n  help: 'Total chat messages sent',\n});\nconst aiCalls = new client.Counter({\n  name: 'sweatyclanker_ai_calls_total',\n  help: 'Total AI API calls made',\n});\nconst aiErrors = new client.Counter({\n  name: 'sweatyclanker_ai_errors_total',\n  help: 'Total AI API call failures',\n});\nconst aiLatency = new client.Histogram({\n  name: 'sweatyclanker_ai_latency_seconds',\n  help: 'AI API call latency in seconds',\n  buckets: [0.1, 0.5, 1, 2, 5, 10],\n});\nconst tokenUsage = new client.Counter({\n  name: 'sweatyclanker_token_usage_estimate_total',\n  help: 'Rough estimated token usage',\n});\n\n[messagesReceived, messagesSent, aiCalls, aiErrors, aiLatency, tokenUsage].forEach((m) =>\n  register.registerMetric(m)\n);\n\nexport const metrics = {\n  messagesReceived,\n  messagesSent,\n  aiCalls,\n  aiErrors,\n  aiLatency,\n  tokenUsage,\n};\n\nexport async function getMetrics() {\n  return register.metrics();\n}\n",
};

// ---- Write files (only if missing) ----
function ensureDirectory(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

for (const [filePath, content] of Object.entries(files)) {
  const dir = path.dirname(filePath);
  ensureDirectory(dir);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content.trimStart(), 'utf8');
    console.log(`Created ${filePath}`);
  } else {
    console.log(`Skipped ${filePath} (already exists)`);
  }
}

console.log('\n✅ SweatyClanker v3 – Setup complete (missing files created).');
console.log('Now run: npm start');
