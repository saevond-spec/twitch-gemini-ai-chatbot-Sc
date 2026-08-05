// ============================================================
// src/app.js – Main application with proactive auto‑messages
// ============================================================
import express from 'express';
import expressWs from 'express-ws';
import { config } from './config/index.js';
import { logger, createLogger } from './logger/index.js';
import { connectRedis, getRedis } from './storage/redis.js';
import { initAuth, exchangeCodeForToken, isAuthorized, getAccessToken } from './twitch/auth.js';
import { TwitchClient } from './twitch/client.js';
import { DeepSeekClient } from './ai/client.js';
import { buildSystemPrompt, buildUserPrompt } from './ai/prompt.js';
import { builtins, loadCustomCommands } from './commands/index.js';
import './commands/builtins.js'; // registers built‑ins
import { Moderation } from './moderation/index.js';
import { CooldownManager } from './utils/cooldown.js';
import { initializeEmotes, getRandomEmote } from './twitch/emotes.js';
import { getSystemPrompt, shouldRespond, getFallbackResponse } from '../personality.js';

const log = createLogger('APP');
const app = express();
const wsInstance = expressWs(app);
app.set('trust proxy', config.server.trustProxy);

// ---------- State ----------
let twitchClient = null;
let deepseek = null;
let moderation = null;
let cooldown = new CooldownManager(config.cooldown);
let customCommands = new Map();
let conversationMemory = {}; // channel -> [{user, text, timestamp}]
let lastActivity = {};       // channel -> timestamp of last message
let wsClients = new Set();

// ---------- Auto‑Message Configuration (env overrides) ----------
const AUTO_ENABLED = process.env.AUTO_MESSAGE_ENABLED !== 'false';
const AUTO_INTERVAL = (parseInt(process.env.AUTO_MESSAGE_INTERVAL) || 300) * 1000; // seconds → ms
const AUTO_USE_DEEPSEEK = process.env.AUTO_USE_DEEPSEEK !== 'false';
const AUTO_QUIET_THRESHOLD = (parseInt(process.env.AUTO_QUIET_THRESHOLD) || 600) * 1000; // 10 min default
const AUTO_WELCOME = process.env.AUTO_WELCOME !== 'false';

// Pre‑defined fallback messages (used if DeepSeek is disabled or fails)
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

// ---------- Middleware ----------
app.use(express.json({ limit: '1mb' }));
app.use('/public', express.static('public'));

// ---------- WebSocket ----------
app.ws('/ws', (ws) => {
  wsClients.add(ws);
  ws.on('close', () => wsClients.delete(ws));
});

function broadcast(data) {
  for (const client of wsClients) {
    if (client.readyState === 1) client.send(JSON.stringify(data));
  }
}

// ---------- Health Checks ----------
app.get('/healthz', (req, res) => res.status(200).send('OK'));
app.get('/readyz', async (req, res) => {
  const ready = {
    redis: !!getRedis(),
    twitch: twitchClient?.connected || false,
    deepseek: !!deepseek,
    auth: isAuthorized(),
  };
  if (Object.values(ready).every(v => v === true)) {
    res.status(200).json(ready);
  } else {
    res.status(503).json(ready);
  }
});

// ---------- Auth Routes ----------
app.get('/auth/login', (req, res) => {
  const redirectUri = `${req.protocol}://${req.get('host')}/auth/callback`;
  const url = `https://id.twitch.tv/oauth2/authorize?client_id=${config.twitch.clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=chat:read+chat:edit+user:bot`;
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    res.status(400).send('Missing code');
    return;
  }
  try {
    const redirectUri = `${req.protocol}://${req.get('host')}/auth/callback`;
    await exchangeCodeForToken(code, redirectUri);
    await initializeBot();
    res.send('Authorization successful! You may close this window.');
  } catch (err) {
    log.error('Auth callback failed', err);
    res.status(500).send('Authorization failed');
  }
});

// ---------- Auto‑Message Functions ----------
async function generateSpontaneousMessage(channel) {
  if (!deepseek || !AUTO_USE_DEEPSEEK) {
    // Use fallback phrase
    const msg = FALLBACK_MESSAGES[fallbackIndex % FALLBACK_MESSAGES.length];
    fallbackIndex++;
    return msg;
  }

  const systemPrompt = `You are SweatyClanker, a Twitch chatter. 
Say something spontaneous, fun, and engaging to the chat. 
Keep it short (1‑2 sentences) and relevant to gaming or Twitch culture. 
Never repeat yourself.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: 'Say something random to the chat.' }
  ];

  try {
    const reply = await deepseek.chat(messages, { temperature: 0.9 });
    return reply;
  } catch (err) {
    log.error('Failed to generate spontaneous message', err);
    return FALLBACK_MESSAGES[fallbackIndex % FALLBACK_MESSAGES.length];
  }
}

function startAutoMessages() {
  if (!AUTO_ENABLED) {
    log.info('Auto‑messages disabled by environment');
    return;
  }
  if (global._autoMessageTimer) clearInterval(global._autoMessageTimer);

  global._autoMessageTimer = setInterval(async () => {
    if (!twitchClient || !twitchClient.connected) return;

    const now = Date.now();
    for (const channel of twitchClient.channels) {
      // Skip if chat is active (within quiet threshold)
      const last = lastActivity[channel] || 0;
      if (now - last < AUTO_QUIET_THRESHOLD) continue;

      // Generate message
      const msg = await generateSpontaneousMessage(channel);
      if (!msg) continue;

      // Optionally append an emote
      let finalMsg = msg;
      if (config.emotes.enable) {
        const emote = getRandomEmote(channel);
        if (emote) finalMsg += ` ${emote}`;
      }

      await twitchClient.say(channel, finalMsg);
      // Store in memory to avoid repetition
      if (!conversationMemory[channel]) conversationMemory[channel] = [];
      conversationMemory[channel].push({ user: 'bot', text: finalMsg, timestamp: now });
      if (conversationMemory[channel].length > 100) {
        conversationMemory[channel] = conversationMemory[channel].slice(-50);
      }
      // Update last activity so we don't spam
      lastActivity[channel] = now;
    }
  }, AUTO_INTERVAL);

  log.info(`Auto‑messages started (interval: ${AUTO_INTERVAL/1000}s, useDeepSeek: ${AUTO_USE_DEEPSEEK})`);
}

// ---------- Bot Initialization ----------
async function initializeBot() {
  if (!isAuthorized()) {
    log.warn('No valid token; bot not starting');
    return;
  }
  if (twitchClient) {
    log.info('Bot already initialized');
    return;
  }

  // DeepSeek
  deepseek = new DeepSeekClient();
  log.info('DeepSeek client ready');

  // Moderation
  moderation = new Moderation(config.moderation);

  // Custom commands
  await loadCustomCommands(customCommands);

  // Twitch client
  twitchClient = new TwitchClient();
  twitchClient.on('connected', () => {
    log.info('Twitch connected');
    broadcast({ type: 'status', connected: true });
    // Start auto‑messages after connection
    startAutoMessages();
  });
  twitchClient.on('disconnected', (reason) => {
    log.warn('Twitch disconnected', reason);
    broadcast({ type: 'status', connected: false });
    if (global._autoMessageTimer) {
      clearInterval(global._autoMessageTimer);
      global._autoMessageTimer = null;
    }
  });

  // Register event handlers
  twitchClient.on('message', handleMessage);
  twitchClient.on('usernotice', handleUserNotice);
  twitchClient.on('clearchat', handleClearChat);

  // Welcome new chatters on JOIN (optional)
  if (AUTO_WELCOME) {
    twitchClient.on('join', handleJoin);
  }

  // Emotes (non-blocking)
  initializeEmotes(config.twitch.channels).catch(err => log.error('Emote init failed', err));

  // Connect
  await twitchClient.connect();
  log.info('Bot initialization complete');
  broadcast({ type: 'ready' });
}

// ---------- Message Handler ----------
async function handleMessage(channel, user, message, self) {
  const username = user['display-name'] || user.username;
  const login = user.username.toLowerCase();

  // Update last activity
  lastActivity[channel] = Date.now();

  if (config.twitch.ignoredUsers.includes(login)) return;

  if (!moderation.isAllowed(channel, user, message)) {
    log.debug(`Moderation blocked message from ${username} in ${channel}`);
    return;
  }

  const cooldownKey = `${channel}:${login}`;
  if (!cooldown.check(cooldownKey)) {
    log.debug(`Cooldown active for ${username} in ${channel}`);
    return;
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
      const response = typeof cmd.response === 'function' ? cmd.response(message, user) : cmd.response;
      await twitchClient.say(channel, response);
      return;
    }
  }

  // Built-in commands
  const builtinKey = lowerMsg.split(' ')[0];
  if (builtins.has(builtinKey)) {
    const cmd = builtins.get(builtinKey);
    const response = await cmd.handler(user, channel, twitchClient);
    if (response) await twitchClient.say(channel, response);
    return;
  }

  // AI chat: only if mentioned or greeting
  const shouldReply = shouldRespond(message, config.twitch.username);
  if (!shouldReply) return;

  // Build conversation history
  const history = conversationMemory[channel] || [];
  const systemPrompt = buildSystemPrompt(channel, user);
  const userPrompt = buildUserPrompt(message, username, history);

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-config.deepseek.maxHistory).map(h => ({ role: 'user', content: h.text })),
    { role: 'user', content: userPrompt },
  ];

  try {
    const reply = await deepseek.chat(messages);
    if (reply) {
      // Update memory
      if (!conversationMemory[channel]) conversationMemory[channel] = [];
      conversationMemory[channel].push({ user: username, text: message, timestamp: Date.now() });
      conversationMemory[channel].push({ user: 'bot', text: reply, timestamp: Date.now() });
      if (conversationMemory[channel].length > 100) {
        conversationMemory[channel] = conversationMemory[channel].slice(-50);
      }

      let finalReply = reply;
      if (config.emotes.enable) {
        const emote = getRandomEmote(channel);
        if (emote) finalReply += ` ${emote}`;
      }
      await twitchClient.say(channel, finalReply);
    }
  } catch (err) {
    log.error('AI chat error', err);
    const fallback = getFallbackResponse();
    await twitchClient.say(channel, fallback);
  }
}

// ---------- JOIN handler (welcome) ----------
async function handleJoin(channel, username, self) {
  if (self) return; // don't welcome ourselves
  // Only welcome if we haven't seen this user recently (avoid spam)
  const key = `${channel}:${username}`;
  if (global._welcomedUsers && global._welcomedUsers.has(key)) return;
  if (!global._welcomedUsers) global._welcomedUsers = new Set();

  // Optionally check if they have spoken before (from memory)
  const history = conversationMemory[channel] || [];
  const hasSpoken = history.some(h => h.user === username);
  if (hasSpoken) return; // already a returning viewer

  const welcomeMsg = `Welcome to the stream, @${username}! Hope you enjoy the chaos.`;
  await twitchClient.say(channel, welcomeMsg);
  global._welcomedUsers.add(key);
  // Clean up set periodically to prevent memory growth
  if (global._welcomedUsers.size > 1000) {
    global._welcomedUsers.clear();
  }
}

// ---------- Other Event Handlers ----------
async function handleUserNotice(channel, user, msg, tags) {
  if (tags['msg-id'] === 'raid') {
    const from = tags['display-name'] || 'someone';
    await twitchClient.say(channel, `Thanks for the raid, ${from}! PogChamp`);
  } else if (tags['msg-id'] === 'sub' || tags['msg-id'] === 'resub') {
    const subName = tags['display-name'] || 'a viewer';
    await twitchClient.say(channel, `Thanks for the sub, ${subName}! Much love <3`);
  }
}

async function handleClearChat(channel) {
  log.info(`Chat cleared in ${channel}`);
}

// ---------- Startup ----------
async function bootstrap() {
  await connectRedis();
  await initAuth();
  if (isAuthorized()) {
    await initializeBot();
  } else {
    log.info('No token, waiting for auth');
  }

  const port = config.server.port;
  app.listen(port, () => {
    log.info(`Server running on port ${port}`);
  });
}

process.on('SIGTERM', async () => {
  log.info('SIGTERM received, shutting down');
  if (global._autoMessageTimer) clearInterval(global._autoMessageTimer);
  if (twitchClient) twitchClient.disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  log.info('SIGINT received, shutting down');
  if (global._autoMessageTimer) clearInterval(global._autoMessageTimer);
  if (twitchClient) twitchClient.disconnect();
  process.exit(0);
});

bootstrap().catch(err => {
  log.error('Bootstrap failed', err);
  process.exit(1);
});
