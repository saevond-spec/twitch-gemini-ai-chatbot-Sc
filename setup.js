// ============================================================
// SETUP SCRIPT – SweatyClanker v3 (Final, All Fixes)
// ============================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
PUBLIC_URL=https://your-app.onrender.com   # Set this to your Render URL

# EventSub
EVENTSUB_SECRET=your_event_sub_secret
EVENTSUB_WSS_URL=wss://eventsub.wss.twitch.tv
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

  // ---- package.json (postinstall, start) ----
  'package.json': JSON.stringify({
    name: 'sweatyclanker-v3',
    version: '3.0.0',
    type: 'module',
    description: 'Full-featured AI streaming platform with EventSub, media generation, moderation, and more',
    main: 'src/app.js',
    scripts: {
      postinstall: 'node setup.js',
      start: 'node src/app.js',
      dev: 'nodemon src/app.js',
      test: 'node --test',
    },
    dependencies: {
      axios: '^1.6.0',
      bullmq: '^5.0.0',
      dotenv: '^16.0.3',
      ejs: '^3.1.9',
      eventemitter2: '^6.4.9',
      express: '^4.18.2',
      'express-ws': '^5.0.2',
      helmet: '^7.0.0',
      'express-rate-limit': '^7.0.0',
      ioredis: '^5.3.2',
      'tmi.js': '^1.8.5',
      winston: '^3.11.0',
      'prom-client': '^15.0.0',
      joi: '^17.11.0',
      'ws': '^8.14.0',
      'multer': '^1.4.5-lts.1',
    },
    devDependencies: {
      nodemon: '^3.0.1',
    },
    engines: { node: '>=18.0.0' },
  }, null, 2),

  'README.md': `
# SweatyClanker v3 – Full‑Feature Twitch AI Bot

Complete platform with IRC, EventSub, media generation, moderation, custom commands, persistent memory, and more.

## Features
- DeepSeek AI (only provider)
- Twitch IRC + EventSub (follows, raids, subs, predictions, polls, channel points, hype train, guest star, shoutouts)
- Media generation (images, videos, TTS, music) via Pollinations API
- Rule‑based + AI moderation
- Custom commands with role permissions (stored in Redis)
- Persistent Redis‑backed memory (conversations, viewer profiles)
- Outgoing message queue for rate limiting
- Brain system (conversation, moderation, coach)
- Security (helmet, rate limiting, origin checks)
- Health, readiness, liveness, metrics endpoints
- Graceful shutdown

## Quick Start
\`npm install\` → configure \`.env\` → \`npm start\`
`,

  // ---- PERSONALITY ----
  'personality.js': `
export function getSystemPrompt() {
  return \`You are SweatyClanker, a laid‑back, funny, and slightly sarcastic Twitch chatter.
You love gaming, memes, and talking to viewers. You speak in lowercase, use Twitch emotes occasionally, and never repeat yourself.
Keep responses short (max 2 sentences) unless asked a detailed question.
Be welcoming, helpful, and always remember recent chat context.\`;
}
export function shouldRespond(message, botUsername) {
  const lower = message.toLowerCase();
  const mention = \`@\${botUsername.toLowerCase()}\`;
  if (lower.includes(mention)) return true;
  const greetings = ['hi', 'hello', 'hey', 'sup', 'yo', 'howdy'];
  if (greetings.some(g => lower.startsWith(g) || lower.includes(\` \${g}\`))) return true;
  return false;
}
export function getFallbackResponse() {
  const fallbacks = [
    'Sorry, I blanked out. What was that?',
    'My brain is buffering… try again?',
    'I need a second. Say that again?',
  ];
  return fallbacks[Math.floor(Math.random() * fallbacks.length)];
}
`,

  // ---- CONFIG (fixed boolean coercion, added PUBLIC_URL) ----
  'src/config/index.js': `
import dotenv from 'dotenv';
import { createLogger } from '../logger/index.js';
dotenv.config();

const log = createLogger('CONFIG');

// Define required variables and their descriptions
const requiredVars = {
  TWITCH_USERNAME: 'Twitch bot account name',
  TWITCH_CLIENT_ID: 'Twitch application Client ID',
  TWITCH_CLIENT_SECRET: 'Twitch application Client Secret',
  JOIN_CHANNELS: 'Comma-separated list of channels to join',
  DEEPSEEK_API_KEY: 'DeepSeek API key',
  EVENTSUB_SECRET: 'Secret for EventSub WebSocket verification',
};

// Check each required variable and log a clear error if missing
const missing = Object.keys(requiredVars).filter(key => !process.env[key]);
if (missing.length) {
  log.error('Missing required environment variables:');
  missing.forEach(key => {
    log.error(\`  - \${key}: \${requiredVars[key]}\`);
  });
  log.error('Please set these variables in your environment and restart.');
  process.exit(1);
}

// Optional variables (with defaults)
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
  EVENTSUB_WSS_URL: 'wss://eventsub.wss.twitch.tv',
  PUBLIC_URL: '', // will default to constructed URL
};

// Merge with environment
const env = { ...optional };
for (const [key, def] of Object.entries(optional)) {
  env[key] = process.env[key] ?? def;
}
// Override with required (already checked)
for (const key of Object.keys(requiredVars)) {
  env[key] = process.env[key];
}

// Additional type conversions
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

// Compute public URL
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
  cooldown: {
    global: env.COOLDOWN_DURATION,
    perUser: env.USER_COOLDOWN,
  },
  moderation: {
    maxRepeats: env.MAX_REPEAT_MESSAGES,
    maxCapsRatio: env.MAX_CAPS_RATIO,
    linkFilter: env.ALLOW_LINKS, // now boolean
  },
  emotes: {
    enable: env.ENABLE_EMOTE_APPENDING, // boolean
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
    wssUrl: env.EVENTSUB_WSS_URL || 'wss://eventsub.wss.twitch.tv',
  },
};

log.info('✅ Configuration validated successfully');
`,

  // ---- LOGGER ----
  'src/logger/index.js': `
import winston from 'winston';
const { combine, timestamp, printf, colorize, errors } = winston.format;
const logFormat = printf(({ level, message, timestamp, label, stack }) => {
  const labelStr = label ? \`[\${label}]\` : '';
  return \`\${timestamp} \${level} \${labelStr} \${stack || message}\`;
});
const transports = [new winston.transports.Console()];
if (process.env.NODE_ENV === 'production') {
  transports.push(new winston.transports.File({ filename: 'logs/combined.log' }));
}
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    colorize({ all: true }),
    logFormat
  ),
  transports,
  exceptionHandlers: transports,
});
export const createLogger = (label) => logger.child({ label });
`,

  // ---- STORAGE ----
  'src/storage/redis.js': `
import Redis from 'ioredis';
import { config } from '../config/index.js';
import { createLogger } from '../logger/index.js';
const log = createLogger('REDIS');
let redis = null;
export async function connectRedis() {
  if (!config.redis.url) {
    log.warn('No REDIS_URL provided, using file storage fallback');
    return null;
  }
  redis = new Redis(config.redis.url, {
    retryStrategy(times) {
      const delay = Math.min(times * 50, 2000);
      log.warn(\`Redis reconnect attempt \${times}, delay \${delay}ms\`);
      return delay;
    },
    maxRetriesPerRequest: 3,
  });
  redis.on('connect', () => log.info('Connected to Redis'));
  redis.on('error', (err) => log.error('Redis error', err));
  redis.on('close', () => log.warn('Redis connection closed'));
  await redis.ping();
  return redis;
}
export function getRedis() { return redis; }
`,

  'src/storage/file.js': `
import fs from 'fs/promises';
import { createLogger } from '../logger/index.js';
const log = createLogger('FILE');
export async function readJSON(filePath, defaultValue = null) {
  try {
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') return defaultValue;
    log.error(\`Failed to read \${filePath}\`, err);
    return defaultValue;
  }
}
export async function writeJSON(filePath, data) {
  try {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    log.error(\`Failed to write \${filePath}\`, err);
  }
}
`,

  // ---- TWITCH AUTH (FIXED: POST body, timeouts, refresh error handling) ----
  'src/twitch/auth.js': `
import axios from 'axios';
import { config } from '../config/index.js';
import { getRedis } from '../storage/redis.js';
import { readJSON, writeJSON } from '../storage/file.js';
import { createLogger } from '../logger/index.js';

const log = createLogger('AUTH');
const TOKEN_KEY = 'twitch:oauth';
const TOKEN_FILE = './tokens.json';
const REQUEST_TIMEOUT_MS = 10000; // 10 seconds

let currentToken = null;
let refreshTimer = null;

// Corrected scopes – added required scopes for EventSub subscriptions
const SCOPES = [
  'chat:read', 'chat:edit',
  'user:bot', 'user:read:chat', 'user:write:chat',
  'moderation:read', 'channel:manage:moderators',
  'channel:read:subscriptions', 'channel:read:redemptions',
  'channel:manage:predictions', 'channel:manage:polls',
  'bits:read', 'channel:read:hype_train',
  'channel:manage:raids', 'channel:read:goals',
  'moderator:read:followers',          // required for channel.follow
  'moderator:manage:shoutouts'         // required for channel.shoutout.create
];

async function loadStoredToken() {
  const redis = getRedis();
  if (redis) {
    try {
      const data = await redis.get(TOKEN_KEY);
      if (data) return JSON.parse(data);
    } catch (err) {
      log.warn('Failed to load token from Redis', err.message);
    }
  }
  return readJSON(TOKEN_FILE, null);
}

async function saveToken(tokenData) {
  const redis = getRedis();
  const expiresIn = tokenData.expires_in || 86400; // default 24h
  if (redis) {
    try {
      await redis.set(TOKEN_KEY, JSON.stringify(tokenData), 'EX', expiresIn);
      log.debug('Token persisted to Redis');
    } catch (err) {
      log.warn('Failed to save token to Redis', err.message);
    }
  }
  try {
    await writeJSON(TOKEN_FILE, tokenData);
    log.debug('Token persisted to file');
  } catch (err) {
    log.warn('Failed to save token to file', err.message);
  }
}

export async function validateToken() {
  if (!currentToken) return false;
  try {
    await axios.get('https://id.twitch.tv/oauth2/validate', {
      headers: { Authorization: \`OAuth \${currentToken.access_token}\` },
      timeout: REQUEST_TIMEOUT_MS,
    });
    return true;
  } catch (err) {
    log.debug('Token validation failed', err.response?.status || err.message);
    return false;
  }
}

export async function initAuth() {
  const stored = await loadStoredToken();
  if (stored) {
    currentToken = stored;
    log.info('Token loaded from storage');
    if (currentToken.expires_at && Date.now() >= currentToken.expires_at - 60000) {
      log.info('Token near expiry, refreshing...');
      await refreshToken();
    }
    const valid = await validateToken();
    if (!valid) {
      log.warn('Token invalid, will refresh on next call');
    }
    scheduleRefresh();
    return true;
  }
  log.info('No token yet – waiting for OAuth');
  return false;
}

export async function exchangeCodeForToken(code, redirectUri) {
  // FIX: Send credentials in POST body (URLSearchParams), not query string
  const params = new URLSearchParams({
    client_id: config.twitch.clientId,
    client_secret: config.twitch.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });

  const response = await axios.post(
    'https://id.twitch.tv/oauth2/token',
    params.toString(),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: REQUEST_TIMEOUT_MS,
    }
  );

  const tokenData = response.data;
  tokenData.expires_at = Date.now() + tokenData.expires_in * 1000;
  tokenData.scopes = SCOPES;
  currentToken = tokenData;
  await saveToken(tokenData);
  scheduleRefresh();
  log.info('Token exchanged successfully');
  return tokenData;
}

async function refreshToken() {
  if (!currentToken) return;

  const params = new URLSearchParams({
    client_id: config.twitch.clientId,
    client_secret: config.twitch.clientSecret,
    refresh_token: currentToken.refresh_token,
    grant_type: 'refresh_token',
  });

  try {
    const response = await axios.post(
      'https://id.twitch.tv/oauth2/token',
      params.toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: REQUEST_TIMEOUT_MS,
      }
    );

    const newData = response.data;
    // Twitch may rotate refresh token – keep the new one if provided
    if (newData.refresh_token) {
      currentToken.refresh_token = newData.refresh_token;
    }
    currentToken.access_token = newData.access_token;
    currentToken.expires_in = newData.expires_in;
    currentToken.expires_at = Date.now() + newData.expires_in * 1000;
    // Keep scopes unchanged
    await saveToken(currentToken);
    log.info('Token refreshed successfully');
  } catch (err) {
    const status = err.response?.status;
    const errorCode = err.response?.data?.error;
    // FIX: Only clear token if refresh token is permanently invalid (invalid_grant)
    if (status === 400 && errorCode === 'invalid_grant') {
      log.error('Refresh token invalid or revoked – manual re-authorization required');
      // Clear current token
      currentToken = null;
      // Optionally clear storage
      try {
        const redis = getRedis();
        if (redis) await redis.del(TOKEN_KEY);
        await writeJSON(TOKEN_FILE, null);
      } catch (e) {
        // ignore cleanup errors
      }
      // Throw so caller knows to re-authorize
      throw new Error('invalid_grant');
    } else {
      // Transient error – keep current token and retry later
      log.warn('Token refresh failed (transient)', err.response?.status || err.message);
      // Reschedule refresh later
      scheduleRefresh();
    }
  }
}

function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  if (!currentToken || !currentToken.expires_at) return;
  const now = Date.now();
  const timeToExpiry = currentToken.expires_at - now;
  const refreshAt = Math.max(timeToExpiry - 60000, 60000);
  refreshTimer = setTimeout(async () => {
    try {
      await refreshToken();
    } catch (err) {
      if (err.message === 'invalid_grant') {
        log.error('Stopping refresh attempts – re-authorization needed');
        return;
      }
    }
    scheduleRefresh();
  }, refreshAt);
}

export function getAccessToken() {
  return currentToken?.access_token || null;
}

export function isAuthorized() {
  return !!getAccessToken();
}
`,

  // ---- TWITCH IRC CLIENT (unchanged, but with fix for cooldown later) ----
  'src/twitch/client.js': `
import tmi from 'tmi.js';
import { config } from '../config/index.js';
import { getAccessToken } from './auth.js';
import { createLogger } from '../logger/index.js';
import { RateLimiter } from '../utils/rateLimiter.js';
import { ReconnectStateMachine } from '../state/reconnectState.js';
const log = createLogger('IRC');
export class TwitchClient {
  constructor() {
    this.client = null;
    this.channels = config.twitch.channels;
    this.connected = false;
    this.rateLimiter = new RateLimiter(20, 30000);
    this.eventListeners = {
      message: [], connected: [], disconnected: [], reconnecting: [],
      roomstate: [], userstate: [], usernotice: [], clearchat: [], clearmsg: [],
      join: [], part: [], whisper: [],
    };
    this._disconnecting = false;
    this.stateMachine = new ReconnectStateMachine({
      maxAttempts: 10,
      baseDelay: 1000,
      maxDelay: 30000,
      jitter: true,
    });
    this.stateMachine.on('reconnecting', (attempt) => {
      log.info(\`Reconnect attempt \${attempt}\`);
      this.emit('reconnecting');
      this.reconnect();
    });
    this.stateMachine.on('failed', () => {
      log.error('Reconnection failed after max attempts');
      this.emit('disconnected', 'Max attempts');
    });
  }

  connect() {
    return new Promise((resolve, reject) => {
      if (this.client) {
        log.warn('Client already exists, disconnecting first');
        this.disconnect();
      }
      const token = getAccessToken();
      if (!token) {
        reject(new Error('No access token available'));
        return;
      }
      log.info('Connecting to Twitch IRC...');
      this.stateMachine.reset();
      this.client = new tmi.Client({
        options: { debug: false },
        identity: {
          username: config.twitch.username,
          password: \`oauth:\${token}\`,
        },
        channels: this.channels,
        connection: { reconnect: true, secure: true },
      });
      this.client.on('connected', (addr, port) => {
        this.connected = true;
        this.stateMachine.connected();
        log.info(\`✅ Connected to \${addr}:\${port}\`);
        this.emit('connected', addr, port);
        resolve();
      });
      this.client.on('disconnected', (reason) => {
        this.connected = false;
        log.warn(\`Disconnected: \${reason}\`);
        this.emit('disconnected', reason);
        if (!this._disconnecting) {
          this.stateMachine.disconnected();
        }
      });
      this.client.on('reconnect', () => {
        log.warn('Received RECONNECT from Twitch');
        this.stateMachine.disconnected();
      });
      this.client.on('message', (channel, user, message, self) => {
        if (self) return;
        this.emit('message', channel, user, message, false);
      });
      this.client.on('roomstate', (channel, state) => this.emit('roomstate', channel, state));
      this.client.on('userstate', (channel, state) => this.emit('userstate', channel, state));
      this.client.on('usernotice', (channel, user, msg, tags) => this.emit('usernotice', channel, user, msg, tags));
      this.client.on('clearchat', (channel) => this.emit('clearchat', channel));
      this.client.on('clearmsg', (channel, user, msg, tags) => this.emit('clearmsg', channel, user, msg, tags));
      this.client.on('join', (channel, username, self) => {
        if (self) log.info(\`Joined \${channel}\`);
        this.emit('join', channel, username, self);
      });
      this.client.on('part', (channel, username, self) => {
        if (self) log.info(\`Left \${channel}\`);
        this.emit('part', channel, username, self);
      });
      this.client.on('whisper', (from, user, message, self) => {
        if (self) return;
        this.emit('whisper', from, user, message);
      });
      const timeout = setTimeout(() => {
        this.stateMachine.failed();
        reject(new Error('Connection timeout'));
      }, 15000);
      this.client.connect().catch((err) => {
        clearTimeout(timeout);
        this.stateMachine.failed();
        reject(err);
      });
    });
  }

  disconnect() {
    this._disconnecting = true;
    this.stateMachine.reset();
    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
    this.connected = false;
    this._disconnecting = false;
  }

  async reconnect() {
    if (this._disconnecting) return;
    try {
      this.disconnect();
      await this.connect();
    } catch (err) {
      log.error('Reconnection attempt failed', err);
      this.stateMachine.failed();
    }
  }

  async say(channel, message) {
    if (!this.connected || !this.client) {
      log.warn('Cannot send message, not connected');
      return false;
    }
    await this.rateLimiter.wait(channel);
    try {
      await this.client.say(channel, message);
      log.debug(\`Sent to \${channel}: \${message}\`);
      return true;
    } catch (err) {
      log.error(\`Failed to send message to \${channel}\`, err);
      return false;
    }
  }

  on(event, fn) {
    if (this.eventListeners[event]) this.eventListeners[event].push(fn);
  }
  emit(event, ...args) {
    (this.eventListeners[event] || []).forEach(fn => fn(...args));
  }
}
`,

  // ---- RECONNECT STATE MACHINE ----
  'src/state/reconnectState.js': `
import EventEmitter from 'events';
export class ReconnectStateMachine extends EventEmitter {
  constructor({ maxAttempts = 10, baseDelay = 1000, maxDelay = 30000, jitter = true } = {}) {
    super();
    this.maxAttempts = maxAttempts;
    this.baseDelay = baseDelay;
    this.maxDelay = maxDelay;
    this.jitter = jitter;
    this.attempt = 0;
    this.timer = null;
    this.state = 'idle';
    this._disconnected = false;
  }
  reset() {
    this.attempt = 0;
    this.state = 'idle';
    this._disconnected = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
  connected() {
    this.state = 'connected';
    this.attempt = 0;
    this._disconnected = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
  disconnected() {
    if (this._disconnected) return;
    this._disconnected = true;
    this.state = 'reconnecting';
    if (this.attempt >= this.maxAttempts) {
      this.state = 'failed';
      this.emit('failed');
      return;
    }
    const delay = Math.min(this.baseDelay * Math.pow(2, this.attempt), this.maxDelay);
    const jitterFactor = this.jitter ? (0.5 + Math.random()) : 1;
    const actualDelay = delay * jitterFactor;
    this.attempt++;
    this.timer = setTimeout(() => {
      this.emit('reconnecting', this.attempt);
    }, actualDelay);
  }
  failed() {
    this.state = 'failed';
    this.emit('failed');
  }
}
`,

  // ---- CIRCUIT BREAKER ----
  'src/circuitBreaker/index.js': `
import { createLogger } from '../logger/index.js';
const log = createLogger('CIRCUIT');
export class CircuitBreaker {
  constructor({ name, failureThreshold = 5, timeout = 60000, resetTimeout = 60000 } = {}) {
    this.name = name;
    this.failureThreshold = failureThreshold;
    this.timeout = timeout;
    this.resetTimeout = resetTimeout;
    this.failures = 0;
    this.lastFailure = 0;
    this.state = 'closed';
    this._openTimer = null;
  }
  isOpen() {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailure > this.resetTimeout) {
        this.state = 'half-open';
        log.info(\`Circuit breaker \${this.name} half-open\`);
      }
      return true;
    }
    return false;
  }
  recordSuccess() {
    this.failures = 0;
    this.state = 'closed';
    if (this._openTimer) {
      clearTimeout(this._openTimer);
      this._openTimer = null;
    }
  }
  recordFailure() {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.failures >= this.failureThreshold) {
      this.state = 'open';
      log.warn(\`Circuit breaker \${this.name} opened after \${this.failures} failures\`);
      this._openTimer = setTimeout(() => {
        this.state = 'half-open';
        log.info(\`Circuit breaker \${this.name} half-open\`);
      }, this.resetTimeout);
    }
  }
  reset() {
    this.failures = 0;
    this.state = 'closed';
    if (this._openTimer) {
      clearTimeout(this._openTimer);
      this._openTimer = null;
    }
  }
}
`,

  // ---- AI CLIENT (unchanged) ----
  'src/ai/client.js': `
import axios from 'axios';
import { config } from '../config/index.js';
import { createLogger } from '../logger/index.js';
import { CircuitBreaker } from '../circuitBreaker/index.js';
import { validateAIResponse, detectPromptInjection } from './safeguards.js';
const log = createLogger('DEEPSEEK');
const promptCache = new Map();
const CACHE_MAX = 100;
const circuitBreaker = new CircuitBreaker({
  name: 'deepseek',
  failureThreshold: config.deepseek.circuitBreakerThreshold || 5,
  timeout: 60000,
  resetTimeout: 60000,
});
export class DeepSeekClient {
  constructor() {
    this.apiKey = config.deepseek.apiKey;
    this.model = config.deepseek.model;
    this.maxTokens = config.deepseek.maxTokens;
    this.temperature = config.deepseek.temperature;
    this.timeout = config.deepseek.timeoutMs || 10000;
    this.retries = config.deepseek.maxRetries || 3;
    this.baseURL = 'https://api.deepseek.com/v1';
  }
  estimateTokens(text) { return Math.ceil(text.length / 4); }
  getCachedSystemPrompt(systemPrompt) {
    const key = systemPrompt.slice(0, 100);
    if (promptCache.has(key)) return promptCache.get(key);
    promptCache.set(key, systemPrompt);
    if (promptCache.size > CACHE_MAX) {
      const firstKey = promptCache.keys().next().value;
      promptCache.delete(firstKey);
    }
    return systemPrompt;
  }
  async chat(messages, options = {}) {
    if (circuitBreaker.isOpen()) {
      throw new Error('Circuit breaker open – too many failures');
    }
    const userMessages = messages.filter(m => m.role === 'user');
    for (const msg of userMessages) {
      if (detectPromptInjection(msg.content)) {
        throw new Error('Prompt injection detected');
      }
    }
    const { temperature = this.temperature, maxTokens = this.maxTokens, stream = false } = options;
    const totalText = messages.map(m => m.content).join(' ');
    const estimatedTokens = this.estimateTokens(totalText);
    const budget = maxTokens || this.maxTokens;
    if (estimatedTokens > budget * 1.5) {
      log.warn('Estimated tokens exceed budget, truncating history');
      while (messages.length > 2 && this.estimateTokens(messages.map(m => m.content).join(' ')) > budget) {
        messages.splice(1, 1);
      }
    }
    const payload = {
      model: this.model,
      messages,
      temperature,
      max_tokens: budget,
      stream,
    };
    let attempt = 0;
    while (attempt < this.retries) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);
        const response = await axios.post(\`\${this.baseURL}/chat/completions\`, payload, {
          headers: { 'Authorization': \`Bearer \${this.apiKey}\`, 'Content-Type': 'application/json' },
          signal: controller.signal,
          timeout: this.timeout,
          responseType: stream ? 'stream' : 'json',
        });
        clearTimeout(timeoutId);
        circuitBreaker.recordSuccess();
        if (stream) return this._handleStream(response);
        const content = response.data.choices[0].message.content;
        validateAIResponse(content);
        log.debug('DeepSeek response received', { usage: response.data.usage });
        return content;
      } catch (err) {
        attempt++;
        circuitBreaker.recordFailure();
        log.error(\`DeepSeek call failed (attempt \${attempt})\`, err);
        if (attempt >= this.retries) throw err;
        const delay = 1000 * Math.pow(2, attempt) + Math.random() * 500;
        await this._delay(delay);
      }
    }
  }
  async _handleStream(response) {
    return new Promise((resolve, reject) => {
      let fullContent = '';
      response.data.on('data', chunk => {
        const lines = chunk.toString().split('\\n').filter(line => line.trim().startsWith('data:'));
        for (const line of lines) {
          const data = line.replace(/^data: /, '').trim();
          if (data === '[DONE]') { resolve(fullContent); return; }
          try {
            const json = JSON.parse(data);
            const content = json.choices[0]?.delta?.content || '';
            fullContent += content;
          } catch (e) { /* ignore */ }
        }
      });
      response.data.on('error', reject);
      response.data.on('end', () => resolve(fullContent));
    });
  }
  _delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
}
`,

  'src/ai/safeguards.js': `
import { createLogger } from '../logger/index.js';
const log = createLogger('AI-SAFEGUARD');
export function detectPromptInjection(text) {
  const lower = text.toLowerCase();
  const patterns = [
    /ignore previous instructions/i,
    /disregard all previous instructions/i,
    /system prompt:/i,
    /override your instructions/i,
    /you are now/i,
    /your new role is/i,
    /act as if/i,
  ];
  for (const pattern of patterns) {
    if (pattern.test(lower)) {
      log.warn('Prompt injection detected', { text });
      return true;
    }
  }
  return false;
}
export function validateAIResponse(response, expectedFormat = 'text') {
  if (expectedFormat === 'json') {
    try { JSON.parse(response); } catch (e) {
      log.warn('AI response is not valid JSON', { response });
      throw new Error('Invalid JSON response');
    }
  }
  if (response.length > 5000) {
    log.warn('AI response too long', { length: response.length });
  }
  return true;
}
`,

  // ---- CONVERSATION STORE (fixed: store username) ----
  'src/memory/conversationStore.js': `
import { getRedis } from '../storage/redis.js';
import { createLogger } from '../logger/index.js';
const log = createLogger('CONVERSATION');
const MAX_HISTORY = 100;
const TTL_SECONDS = 86400;
export class ConversationStore {
  static async pushMessage(channel, role, content, username = null) {
    const redis = getRedis();
    if (!redis) return;
    const key = \`conv:\${channel}\`;
    const entry = JSON.stringify({ role, content, ts: Date.now(), username });
    await redis.lpush(key, entry);
    await redis.ltrim(key, 0, MAX_HISTORY - 1);
    await redis.expire(key, TTL_SECONDS);
  }
  static async getHistory(channel, limit = 20) {
    const redis = getRedis();
    if (!redis) return [];
    const key = \`conv:\${channel}\`;
    const items = await redis.lrange(key, 0, limit - 1);
    return items.map(JSON.parse).reverse();
  }
  static async getLastActivity(channel) {
    const redis = getRedis();
    if (!redis) return 0;
    const ts = await redis.get(\`lastact:\${channel}\`);
    return ts ? parseInt(ts) : 0;
  }
  static async updateLastActivity(channel, timestamp = Date.now()) {
    const redis = getRedis();
    if (!redis) return;
    await redis.set(\`lastact:\${channel}\`, String(timestamp), 'EX', TTL_SECONDS);
  }
}
`,

  // ---- PROFILE STORE (unchanged) ----
  'src/memory/profileStore.js': `
import { getRedis } from '../storage/redis.js';
const TTL_SECONDS = 2592000; // 30 days
export class ProfileStore {
  static async get(channel, viewer) {
    const redis = getRedis();
    if (!redis) return { firstSeen: Date.now(), lastSeen: Date.now(), preferences: {}, notes: [] };
    const data = await redis.get(\`profile:\${channel}:\${viewer}\`);
    return data ? JSON.parse(data) : { firstSeen: Date.now(), lastSeen: Date.now(), preferences: {}, notes: [] };
  }
  static async update(channel, viewer, updates) {
    const redis = getRedis();
    if (!redis) return;
    const profile = await this.get(channel, viewer);
    Object.assign(profile, updates, { lastSeen: Date.now() });
    await redis.set(\`profile:\${channel}:\${viewer}\`, JSON.stringify(profile), 'EX', TTL_SECONDS);
  }
  static async addNote(channel, viewer, note) {
    const profile = await this.get(channel, viewer);
    profile.notes.push({ text: note, timestamp: Date.now() });
    await this.update(channel, viewer, profile);
  }
}
`,

  // ---- MESSAGE QUEUE (unchanged) ----
  'src/queue/messageQueue.js': `
import { createLogger } from '../logger/index.js';
const log = createLogger('MSG-QUEUE');
const buckets = new Map();
export class MessageQueue {
  constructor(twitchClient) {
    this.client = twitchClient;
    this.queue = new Map();
    this.processing = new Set();
    this.interval = null;
    this.start();
  }
  start() {
    this.interval = setInterval(() => this.process(), 500);
  }
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
  enqueue(channel, message) {
    if (!this.queue.has(channel)) {
      this.queue.set(channel, []);
    }
    this.queue.get(channel).push(message);
    log.debug(\`Message queued for \${channel}\`);
  }
  async process() {
    const now = Date.now();
    for (const [channel, messages] of this.queue) {
      if (this.processing.has(channel)) continue;
      if (!messages.length) continue;
      let bucket = buckets.get(channel);
      if (!bucket) {
        bucket = { tokens: 20, lastRefill: now };
        buckets.set(channel, bucket);
      }
      const elapsed = now - bucket.lastRefill;
      const refill = Math.floor(elapsed / 30000) * 20;
      if (refill > 0) {
        bucket.tokens = Math.min(20, bucket.tokens + refill);
        bucket.lastRefill = now;
      }
      if (bucket.tokens <= 0) continue;
      const msg = messages.shift();
      this.processing.add(channel);
      try {
        await this.client.say(channel, msg);
        bucket.tokens--;
        log.debug(\`Sent queued message to \${channel}, remaining tokens: \${bucket.tokens}\`);
      } catch (err) {
        log.error(\`Failed to send queued message to \${channel}\`, err);
        messages.push(msg);
      } finally {
        this.processing.delete(channel);
      }
    }
    for (const [channel, messages] of this.queue) {
      if (!messages.length) {
        this.queue.delete(channel);
      }
    }
  }
}
`,

  // ---- TWITCH HELIX (unchanged, but subscriptions will now work with correct scopes) ----
  'src/twitch/helix.js': `
import axios from 'axios';
import { getAccessToken } from './auth.js';
import { createLogger } from '../logger/index.js';
const log = createLogger('HELIX');
export class HelixClient {
  constructor() {
    this.baseURL = 'https://api.twitch.tv/helix';
  }
  async getHeaders() {
    const token = getAccessToken();
    if (!token) throw new Error('No access token available');
    return {
      'Authorization': \`Bearer \${token}\`,
      'Client-Id': process.env.TWITCH_CLIENT_ID,
    };
  }
  async getUserByLogin(login) {
    const headers = await this.getHeaders();
    const res = await axios.get(\`\${this.baseURL}/users?login=\${login}\`, { headers });
    return res.data.data[0];
  }
  async getChannelInfo(broadcasterId) {
    const headers = await this.getHeaders();
    const res = await axios.get(\`\${this.baseURL}/channels?broadcaster_id=\${broadcasterId}\`, { headers });
    return res.data.data[0];
  }
  async createEventSubSubscription(type, version, condition, transport) {
    const headers = await this.getHeaders();
    const body = { type, version, condition, transport };
    try {
      const res = await axios.post(\`\${this.baseURL}/eventsub/subscriptions\`, body, { headers });
      log.info(\`EventSub subscription created for \${type}\`);
      return res.data;
    } catch (err) {
      log.error(\`Failed to create subscription for \${type}\`, err.response?.data || err.message);
      throw err;
    }
  }
  async subscribeFollow(broadcasterId) {
    return this.createEventSubSubscription('channel.follow', '2', { broadcaster_user_id: broadcasterId, moderator_user_id: broadcasterId }, { method: 'websocket', session_id: global._eventsubSessionId });
  }
  async subscribeRaid(toBroadcasterId, fromBroadcasterId) {
    return this.createEventSubSubscription('channel.raid', '1', { to_broadcaster_user_id: toBroadcasterId, from_broadcaster_user_id: fromBroadcasterId }, { method: 'websocket', session_id: global._eventsubSessionId });
  }
  async subscribePrediction(broadcasterId) {
    return this.createEventSubSubscription('channel.prediction', '1', { broadcaster_user_id: broadcasterId }, { method: 'websocket', session_id: global._eventsubSessionId });
  }
  async subscribePoll(broadcasterId) {
    return this.createEventSubSubscription('channel.poll', '1', { broadcaster_user_id: broadcasterId }, { method: 'websocket', session_id: global._eventsubSessionId });
  }
  async subscribeGoal(broadcasterId) {
    return this.createEventSubSubscription('channel.goal', '1', { broadcaster_user_id: broadcasterId }, { method: 'websocket', session_id: global._eventsubSessionId });
  }
  async subscribeBits(broadcasterId) {
    return this.createEventSubSubscription('channel.bit', '1', { broadcaster_user_id: broadcasterId }, { method: 'websocket', session_id: global._eventsubSessionId });
  }
  async subscribeSubscription(broadcasterId) {
    return this.createEventSubSubscription('channel.subscribe', '1', { broadcaster_user_id: broadcasterId }, { method: 'websocket', session_id: global._eventsubSessionId });
  }
  async subscribeSubscriptionGift(broadcasterId) {
    return this.createEventSubSubscription('channel.subscription.gift', '1', { broadcaster_user_id: broadcasterId }, { method: 'websocket', session_id: global._eventsubSessionId });
  }
  async subscribeChannelPoints(broadcasterId) {
    return this.createEventSubSubscription('channel.channel_points_custom_reward_redemption.add', '1', { broadcaster_user_id: broadcasterId }, { method: 'websocket', session_id: global._eventsubSessionId });
  }
  async subscribeHypeTrain(broadcasterId) {
    return this.createEventSubSubscription('channel.hype_train', '1', { broadcaster_user_id: broadcasterId }, { method: 'websocket', session_id: global._eventsubSessionId });
  }
  async subscribeGuestStar(broadcasterId) {
    return this.createEventSubSubscription('channel.guest_star_session.begin', '1', { broadcaster_user_id: broadcasterId }, { method: 'websocket', session_id: global._eventsubSessionId });
  }
  async subscribeShoutout(broadcasterId) {
    return this.createEventSubSubscription('channel.shoutout.create', '1', { broadcaster_user_id: broadcasterId, moderator_user_id: broadcasterId }, { method: 'websocket', session_id: global._eventsubSessionId });
  }
}
`,

  // ---- EVENTSUB CLIENT (unchanged) ----
  'src/twitch/eventsub.js': `
import WebSocket from 'ws';
import { createLogger } from '../logger/index.js';
import { config } from '../config/index.js';
import bus from '../bus/index.js';
import { HelixClient } from './helix.js';
import { getRedis } from '../storage/redis.js';
const log = createLogger('EVENTSUB');
export class EventSubClient {
  constructor() {
    this.ws = null;
    this.heartbeatInterval = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 1000;
    this._disconnecting = false;
    this.sessionId = null;
    this.helix = new HelixClient();
    this.broadcasterIds = new Set();
  }
  async connect() {
    return new Promise((resolve, reject) => {
      if (this.ws) {
        log.warn('EventSub WebSocket already exists, disconnecting first');
        this.disconnect();
      }
      this._disconnecting = false;
      const url = config.eventsub.wssUrl || 'wss://eventsub.wss.twitch.tv';
      this.ws = new WebSocket(url);
      this.ws.on('open', () => {
        log.info('EventSub WebSocket connected');
        this.reconnectAttempts = 0;
        this.reconnectDelay = 1000;
        resolve();
      });
      this.ws.on('message', (data) => this.handleMessage(data));
      this.ws.on('error', (err) => {
        log.error('EventSub WebSocket error', err);
        if (!this._disconnecting) this.reconnect();
      });
      this.ws.on('close', () => {
        log.warn('EventSub WebSocket closed');
        if (!this._disconnecting) this.reconnect();
      });
      this.heartbeatInterval = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.ping();
        }
      }, 30000);
    });
  }
  disconnect() {
    this._disconnecting = true;
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
  reconnect() {
    if (this._disconnecting) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      log.error('Max EventSub reconnect attempts reached');
      return;
    }
    this.reconnectAttempts++;
    const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts), 30000);
    setTimeout(() => {
      log.info(\`Reconnecting EventSub attempt \${this.reconnectAttempts}\`);
      this.connect().catch(() => {});
    }, delay);
  }
  async handleMessage(rawData) {
    try {
      const data = JSON.parse(rawData);
      if (data.metadata && data.metadata.message_type === 'session_welcome') {
        this.sessionId = data.payload.session.id;
        global._eventsubSessionId = this.sessionId;
        log.info(\`EventSub session established: \${this.sessionId}\`);
        await this.subscribeToAllEvents();
      } else if (data.metadata && data.metadata.message_type === 'notification') {
        const event = data.payload.event;
        const type = data.metadata.subscription_type;
        bus.emit(\`eventsub.\${type}\`, event);
        bus.emit('eventsub.event', { type, event });
        const redis = getRedis();
        if (redis) {
          const key = \`eventsub:\${type}:\${Date.now()}\`;
          await redis.set(key, JSON.stringify(event), 'EX', 3600);
        }
        this.handleEvent(type, event);
      }
    } catch (err) {
      log.error('Failed to parse EventSub message', err);
    }
  }
  async subscribeToAllEvents() {
    if (!this.sessionId) return;
    const channels = config.twitch.channels;
    for (const ch of channels) {
      const clean = ch.replace('#', '').toLowerCase();
      try {
        const user = await this.helix.getUserByLogin(clean);
        if (user && user.id) {
          this.broadcasterIds.add(user.id);
        }
      } catch (err) {
        log.error(\`Failed to resolve user \${clean}\`, err);
      }
    }
    const broadcasterId = this.broadcasterIds.values().next().value;
    if (!broadcasterId) {
      log.warn('No broadcaster ID found for EventSub subscriptions');
      return;
    }
    const subscriptions = [
      this.helix.subscribeFollow(broadcasterId),
      this.helix.subscribeRaid(broadcasterId, broadcasterId),
      this.helix.subscribePrediction(broadcasterId),
      this.helix.subscribePoll(broadcasterId),
      this.helix.subscribeGoal(broadcasterId),
      this.helix.subscribeBits(broadcasterId),
      this.helix.subscribeSubscription(broadcasterId),
      this.helix.subscribeSubscriptionGift(broadcasterId),
      this.helix.subscribeChannelPoints(broadcasterId),
      this.helix.subscribeHypeTrain(broadcasterId),
      this.helix.subscribeGuestStar(broadcasterId),
      this.helix.subscribeShoutout(broadcasterId),
    ];
    try {
      await Promise.all(subscriptions);
      log.info('All EventSub subscriptions created successfully');
    } catch (err) {
      log.error('Some EventSub subscriptions failed', err);
    }
  }
  handleEvent(type, event) {
    const channel = config.twitch.channels[0] || '#saevond';
    const message = this.generateResponse(type, event);
    if (message) {
      bus.emit('twitch.send', { channel, message });
    }
  }
  generateResponse(type, event) {
    const templates = {
      'channel.follow': (e) => \`Thanks for the follow, @\${e.user_name}! ❤️\`,
      'channel.raid': (e) => \`Raid incoming from \${e.from_broadcaster_user_name}! Let's show them love! 🔥\`,
      'channel.subscribe': (e) => \`Welcome to the sub club, @\${e.user_name}! PogChamp\`,
      'channel.subscription.gift': (e) => \`\${e.user_name} gifted \${e.total} subs! Thank you! 🎉\`,
      'channel.bit': (e) => \`\${e.user_name} just cheered \${e.bits} bits! Thank you! 💎\`,
      'channel.prediction': (e) => \`A new prediction is live! Get your points in! 🔮\`,
      'channel.poll': (e) => \`A new poll is running! Cast your vote! 📊\`,
      'channel.goal': (e) => \`New goal: \${e.title}! Let's help reach it! 🎯\`,
      'channel.channel_points_custom_reward_redemption.add': (e) => \`\${e.user_name} redeemed \${e.reward.title}! Nice! 🎁\`,
      'channel.hype_train': (e) => \`Hype train level \${e.level}! Keep it going! 🚂\`,
      'channel.guest_star_session.begin': (e) => \`Guest star session starting! Let's welcome them! 🌟\`,
      'channel.shoutout.create': (e) => \`Shoutout to @\${e.recommended_user_name}! Go check them out! 📢\`,
    };
    const template = templates[type];
    return template ? template(event) : null;
  }
}
`,

  // ---- MODERATION (unchanged) ----
  'src/moderation/index.js': `
export class Moderation {
  constructor(config) {
    this.maxRepeats = config.maxRepeats || 3;
    this.maxCapsRatio = config.maxCapsRatio || 0.7;
    this.linkFilter = config.linkFilter !== false;
    this.messageHistory = new Map();
  }
  analyze(channel, user, message) {
    const username = user.username.toLowerCase();
    if (user.badges?.broadcaster || user.mod || user.badges?.vip) {
      return { blocked: false, riskScore: 0 };
    }
    let riskScore = 0;
    const history = this.messageHistory.get(username) || [];
    const now = Date.now();
    const recent = history.filter(h => now - h.time < 10000);
    const sameMsgCount = recent.filter(h => h.text === message).length;
    if (sameMsgCount >= this.maxRepeats) riskScore += 50;
    this.messageHistory.set(username, [...recent, { time: now, text: message }]);
    const letters = message.replace(/[^a-zA-Z]/g, '');
    if (letters.length > 5) {
      const caps = (message.match(/[A-Z]/g) || []).length;
      if (caps / letters.length > this.maxCapsRatio) riskScore += 30;
    }
    if (this.linkFilter && /https?:\\/\\/\\S+/i.test(message)) riskScore += 40;
    if (/(.)\\1{5,}/.test(message)) riskScore += 20;
    const blocked = riskScore >= 70;
    return { blocked, riskScore };
  }
  isAllowed(channel, user, message) {
    return !this.analyze(channel, user, message).blocked;
  }
}
`,

  // ---- COMMANDS (unchanged) ----
  'src/commands/index.js': `
import { getRedis } from '../storage/redis.js';
import { createLogger } from '../logger/index.js';
const log = createLogger('COMMANDS');
export const builtins = new Map();

export function registerBuiltin(name, handler, description) {
  builtins.set(name, { handler, description });
}

export async function loadCustomCommands() {
  const redis = getRedis();
  if (!redis) {
    log.warn('No Redis, custom commands not loaded');
    return new Map();
  }
  const keys = await redis.keys('cmd:*');
  const commands = new Map();
  for (const key of keys) {
    const data = await redis.get(key);
    if (data) {
      const cmd = JSON.parse(data);
      commands.set(cmd.name, cmd);
    }
  }
  log.info(\`Loaded \${commands.size} custom commands from Redis\`);
  return commands;
}

export async function saveCustomCommand(name, response, role = 'all') {
  const redis = getRedis();
  if (!redis) return false;
  const cmd = { name, response, role };
  await redis.set(\`cmd:\${name}\`, JSON.stringify(cmd));
  return true;
}

export async function deleteCustomCommand(name) {
  const redis = getRedis();
  if (!redis) return false;
  await redis.del(\`cmd:\${name}\`);
  return true;
}
`,

  // ---- MEDIA (unchanged) ----
  'src/media/providers.js': `
import axios from 'axios';
import { createLogger } from '../logger/index.js';
const log = createLogger('MEDIA');

export class PollinationsClient {
  async generateImage(prompt) {
    const url = \`https://image.pollinations.ai/prompt/\${encodeURIComponent(prompt)}\`;
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    return { buffer: response.data, mimeType: 'image/png' };
  }
  async generateVideo(prompt) {
    const url = \`https://video.pollinations.ai/prompt/\${encodeURIComponent(prompt)}\`;
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    return { buffer: response.data, mimeType: 'video/mp4' };
  }
  async generateAudio(prompt) {
    const url = \`https://pollinations.ai/audio?text=\${encodeURIComponent(prompt)}\`;
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    return { buffer: response.data, mimeType: 'audio/mpeg' };
  }
  async generateMusic(prompt) {
    const url = \`https://pollinations.ai/music?prompt=\${encodeURIComponent(prompt)}\`;
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    return { buffer: response.data, mimeType: 'audio/mpeg' };
  }
}
`,

  // ---- APP.JS (fixed: cooldown, media URL, unhandled rejection protection, conversation store updates) ----
  'src/app.js': `
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

// ---- Security ----
app.use(helmet());
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  validate: false,
});
app.use(limiter);
const allowedOrigins = config.server.allowedOrigins || [];
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && allowedOrigins.length && !allowedOrigins.includes(origin)) {
    return res.status(403).send('Forbidden');
  }
  next();
});

// ---- State ----
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
// Capture public URL from config
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

// ---- Middleware ----
app.use(express.json({ limit: '10mb' }));
app.use('/public', express.static('public'));

// ---- WebSocket ----
app.ws('/ws', (ws) => {
  wsClients.add(ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('close', () => wsClients.delete(ws));
});
heartbeatInterval = setInterval(() => {
  for (const ws of wsClients) {
    if (!ws.isAlive) {
      ws.terminate();
      wsClients.delete(ws);
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

function broadcast(data) {
  for (const client of wsClients) {
    if (client.readyState === 1) client.send(JSON.stringify(data));
  }
}

// ---- Root ----
app.get('/', (req, res) => {
  res.send(\`
    <h1>SweatyClanker Bot</h1>
    <p>Status: <strong>Running</strong></p>
    <p><a href="/auth/login">Authorize on Twitch</a></p>
  \`);
});

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

// ---- Metrics ----
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', 'text/plain');
  res.send(await getMetrics());
});

// ---- Auth ----
app.get('/auth/login', (req, res) => {
  const redirectUri = \`\${req.protocol}://\${req.get('host')}/auth/callback\`;
  const url = \`https://id.twitch.tv/oauth2/authorize?client_id=\${config.twitch.clientId}&redirect_uri=\${encodeURIComponent(redirectUri)}&response_type=code&scope=chat:read chat:edit user:bot user:read:chat user:write:chat moderation:read channel:manage:moderators channel:read:subscriptions channel:read:redemptions channel:manage:predictions channel:manage:polls bits:read channel:read:hype_train channel:manage:raids channel:read:goals moderator:read:followers moderator:manage:shoutouts\`;
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    res.status(400).send('Missing code');
    return;
  }
  try {
    const redirectUri = \`\${req.protocol}://\${req.get('host')}/auth/callback\`;
    await exchangeCodeForToken(code, redirectUri);
    await initializeBot();
    res.send('Authorization successful! You may close this window.');
  } catch (err) {
    log.error('Auth callback failed', err);
    res.status(500).send('Authorization failed');
  }
});

// ---- API routes ----
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

// ---- Auto‑message generation ----
async function generateSpontaneousMessage(channel) {
  if (!deepseek || !AUTO_USE_DEEPSEEK) {
    const msg = FALLBACK_MESSAGES[fallbackIndex % FALLBACK_MESSAGES.length];
    fallbackIndex++;
    return msg;
  }
  const systemPrompt = \`You are SweatyClanker, a Twitch chatter. Say something spontaneous, fun, and engaging to the chat. Keep it short (1‑2 sentences).\`;
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
      if (messageQueue) {
        messageQueue.enqueue(channel, finalMsg);
      } else {
        await twitchClient.say(channel, finalMsg);
      }
      promMetrics.messagesSent.inc();
      await ConversationStore.pushMessage(channel, 'bot', finalMsg);
    }
  }, AUTO_INTERVAL);
  log.info(\`Auto‑messages started (interval: \${AUTO_INTERVAL/1000}s)\`);
}

async function loadCustomCommandsIntoMemory() {
  customCommands = await loadCustomCommands();
}

// ---- Bot initialization ----
async function initializeBot() {
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
    log.info('Connecting to EventSub...');
    eventSubClient = new EventSubClient();
    await eventSubClient.connect();
    log.info('EventSub client connected');
  }

  // Wrap bus listeners in try/catch to prevent process crashes
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

// ---- Main message handler (cooldown fixed: only check after we decide to respond) ----
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
      // Check cooldown before replying
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
    // Check cooldown before replying
    const cooldownKey = \`\${channel}:\${login}\`;
    if (!cooldown.check(cooldownKey)) {
      log.debug(\`Cooldown active for \${username} in \${channel}\`);
      return;
    }
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
        // Cooldown check
        const cooldownKey = \`\${channel}:\${login}\`;
        if (!cooldown.check(cooldownKey)) {
          log.debug(\`Cooldown active for \${username} in \${channel}\`);
          return;
        }
        if (messageQueue) messageQueue.enqueue(channel, response);
        else await global.twitchClient.say(channel, response);
        return;
      }
      // Check cooldown before media generation
      const cooldownKey = \`\${channel}:\${login}\`;
      if (!cooldown.check(cooldownKey)) {
        log.debug(\`Cooldown active for \${username} in \${channel}\`);
        return;
      }
      try {
        const result = await handler(prompt);
        const ext = type === 'image' ? 'png' : type === 'video' ? 'mp4' : 'mp3';
        const filename = \`media-\${Date.now()}.\${ext}\`;
        await writeFile(\`public/\${filename}\`, result.buffer);
        // Use captured publicUrl instead of req
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

  // AI chat – only if mention or greeting
  const shouldReply = shouldRespond(message, config.twitch.username);
  if (!shouldReply) return;

  // Check cooldown before AI response
  const cooldownKey = \`\${channel}:\${login}\`;
  if (!cooldown.check(cooldownKey)) {
    log.debug(\`Cooldown active for \${username} in \${channel}\`);
    return;
  }

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
  // Fix: check if user has ever spoken using stored username
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

// ---- Startup ----
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

  if (authorized) {
    await initializeBot();
  } else {
    log.info('No token, waiting for auth');
  }

  const port = config.server.port;
  server = app.listen(port, () => {
    log.info(\`🌐 Server running on port \${port}\`);
  });
}

// ---- Shutdown ----
async function shutdown() {
  log.info('Shutting down gracefully...');
  if (global._autoMessageTimer) clearInterval(global._autoMessageTimer);
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  if (messageQueue) messageQueue.stop();
  if (eventSubClient) eventSubClient.disconnect();
  await drainQueues();
  if (global.twitchClient) {
    global.twitchClient.disconnect();
  }
  const redis = getRedis();
  if (redis) await redis.quit();
  if (server) {
    await new Promise(resolve => {
      server.close(() => {
        log.info('HTTP server closed');
        resolve();
      });
      setTimeout(() => {
        log.warn('Forcing server close');
        resolve();
      }, 5000);
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

  // ---- PLACEHOLDER FILES ----
  'src/twitch/emotes.js': `
import { createLogger } from '../logger/index.js';
const log = createLogger('EMOTES');
export async function initializeEmotes(channels) {
  log.info(\`Emotes initialized for \${channels.length} channels (stub)\`);
  return new Map();
}
let emotePools = new Map();
export function getRandomEmote(channel) {
  const pool = emotePools.get(channel) || [];
  if (!pool.length) return '';
  return pool[Math.floor(Math.random() * pool.length)];
}
export function setEmotePools(pools) { emotePools = pools; }
`,

  'src/bus/index.js': `
import EventEmitter2 from 'eventemitter2';
const bus = new EventEmitter2({ wildcard: true, delimiter: '.', maxListeners: 50 });
bus.emitAsync = function(event, ...args) {
  return new Promise((resolve) => { this.emit(event, ...args, resolve); });
};
export default bus;
`,

  'src/plugins/index.js': `
import fs from 'fs';
import path from 'path';
import { createLogger } from '../logger/index.js';
const log = createLogger('PLUGIN');
export async function loadPlugins(bus, config) {
  const pluginsDir = path.resolve(process.cwd(), 'plugins');
  if (!fs.existsSync(pluginsDir)) return;
  const items = fs.readdirSync(pluginsDir, { withFileTypes: true });
  for (const item of items) {
    if (!item.isDirectory()) continue;
    try {
      const pluginPath = path.join(pluginsDir, item.name, 'index.js');
      if (!fs.existsSync(pluginPath)) continue;
      const plugin = await import(pluginPath);
      if (plugin.manifest && typeof plugin.register === 'function') {
        await plugin.register(bus, config);
        log.info(\`Plugin "\${item.name}" registered\`);
      }
    } catch (err) {
      log.error(\`Failed to load plugin "\${item.name}"\`, err);
    }
  }
}
`,

  // ---- QUEUE (PATCHED: dedicated Redis connection for BullMQ) ----
  'src/queue/index.js': `
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { config } from '../config/index.js';
import { createLogger } from '../logger/index.js';
const log = createLogger('QUEUE');
let queues = {};
let workers = {};

// BullMQ requires its own dedicated connection with maxRetriesPerRequest: null
// (it issues blocking commands like BLPOP, which are incompatible with the
// shared app-wide ioredis client's default retry/timeout behavior).
let bullConnection = null;
function getBullConnection() {
  if (!bullConnection) {
    if (!config.redis.url) throw new Error('Redis not connected');
    bullConnection = new Redis(config.redis.url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    bullConnection.on('error', (err) => log.error('BullMQ Redis connection error', err));
  }
  return bullConnection;
}

export function getQueue(name) {
  if (!queues[name]) {
    queues[name] = new Queue(name, { connection: getBullConnection() });
  }
  return queues[name];
}
export function enqueueTask(queueName, data, opts = {}) {
  const queue = getQueue(queueName);
  return queue.add(queueName, data, { attempts: 3, backoff: { type: 'exponential', delay: 1000 }, ...opts });
}
export function startWorker(queueName, handler, concurrency = 1) {
  if (workers[queueName]) return workers[queueName];
  const worker = new Worker(queueName, async job => {
    log.info(\`Processing job \${queueName}:\${job.id}\`);
    try { await handler(job.data); } catch (err) { log.error(\`Job \${job.id} failed\`, err); throw err; }
  }, { connection: getBullConnection(), concurrency });
  worker.on('completed', job => log.info(\`Job \${job.id} completed\`));
  worker.on('failed', (job, err) => log.error(\`Job \${job.id} failed\`, err));
  workers[queueName] = worker;
  return worker;
}
export async function drainQueues() {
  for (const [name, queue] of Object.entries(queues)) { await queue.drain(); }
  for (const [name, worker] of Object.entries(workers)) { await worker.close(); }
  if (bullConnection) { await bullConnection.quit(); bullConnection = null; }
}
`,

  'src/queue/handlers.js': `
import { createLogger } from '../logger/index.js';
const log = createLogger('WORKER');
export const jobHandlers = {
  'analyze-vod': async ({ vodId, channel }) => { log.info('Analyzing VOD', { vodId, channel }); },
  'generate-clips': async ({ vodId, timestamps }) => { log.info('Generating clips', { vodId, timestamps }); },
  'create-thumbnail': async ({ videoId, timestamp }) => { log.info('Creating thumbnail', { videoId, timestamp }); },
  'stream-summary': async ({ channel, duration }) => { log.info('Generating stream summary', { channel, duration }); },
  'post-social': async ({ platform, content }) => { log.info('Posting to social', { platform, content }); },
  'discord-announce': async ({ channel, message }) => { log.info('Announcing to Discord', { channel, message }); },
  'moderation-review': async ({ channel, user, message }) => { log.info('Moderation review', { channel, user, message }); },
  'memory-cleanup': async () => { log.info('Cleaning up memory'); },
};
`,

  'src/utils/rateLimiter.js': `
export class RateLimiter {
  constructor(maxTokens, refillInterval) {
    this.maxTokens = maxTokens;
    this.refillInterval = refillInterval;
    this.tokens = new Map();
  }
  async wait(channel) {
    const key = channel.toLowerCase();
    const now = Date.now();
    let bucket = this.tokens.get(key);
    if (!bucket) {
      bucket = { tokens: this.maxTokens, lastRefill: now };
      this.tokens.set(key, bucket);
    }
    const elapsed = now - bucket.lastRefill;
    const refillAmount = Math.floor(elapsed / this.refillInterval) * this.maxTokens;
    if (refillAmount > 0) {
      bucket.tokens = Math.min(this.maxTokens, bucket.tokens + refillAmount);
      bucket.lastRefill = now;
    }
    if (bucket.tokens <= 0) {
      const waitTime = this.refillInterval - (now - bucket.lastRefill);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      bucket.tokens = this.maxTokens;
      bucket.lastRefill = Date.now();
    }
    bucket.tokens -= 1;
  }
}
`,

  // ---- FIXED COOLDOWN MANAGER (only updates timestamps when check passes) ----
  'src/utils/cooldown.js': `
export class CooldownManager {
  constructor(config) {
    this.globalCooldown = config.global || 1;
    this.userCooldown = config.perUser || 5;
    this.lastGlobal = 0;
    this.userTimers = new Map();
  }

  // Returns true if the message is allowed (i.e., cooldown not triggered)
  // Updates the global and user timestamps ONLY when the check passes (i.e., returns true)
  check(key) {
    const now = Date.now();
    // Check global cooldown
    if (now - this.lastGlobal < this.globalCooldown * 1000) {
      return false;
    }
    // Check user cooldown
    const lastUser = this.userTimers.get(key) || 0;
    if (now - lastUser < this.userCooldown * 1000) {
      return false;
    }
    // If we get here, cooldown is not active – update timestamps
    this.lastGlobal = now;
    this.userTimers.set(key, now);
    return true;
  }
}
`,

  'src/utils/metrics.js': `
import client from 'prom-client';
const register = new client.Registry();
client.collectDefaultMetrics({ register });
export const metrics = {
  messagesReceived: new client.Counter({ name: 'messages_received_total', help: 'Total messages received' }),
  messagesSent: new client.Counter({ name: 'messages_sent_total', help: 'Total messages sent' }),
  aiCalls: new client.Counter({ name: 'ai_calls_total', help: 'Total AI calls' }),
  aiErrors: new client.Counter({ name: 'ai_errors_total', help: 'Total AI errors' }),
  aiLatency: new client.Histogram({ name: 'ai_latency_seconds', help: 'AI latency in seconds', buckets: [0.1, 0.5, 1, 2, 5] }),
  tokenUsage: new client.Counter({ name: 'ai_tokens_used_total', help: 'Total tokens used' }),
  queueDepth: new client.Gauge({ name: 'queue_depth', help: 'Number of jobs in queue' }),
  activeViewers: new client.Gauge({ name: 'active_viewers', help: 'Active viewers count' }),
};
register.registerMetric(metrics.messagesReceived);
register.registerMetric(metrics.messagesSent);
register.registerMetric(metrics.aiCalls);
register.registerMetric(metrics.aiErrors);
register.registerMetric(metrics.aiLatency);
register.registerMetric(metrics.tokenUsage);
register.registerMetric(metrics.queueDepth);
register.registerMetric(metrics.activeViewers);
export function getMetrics() { return register.metrics(); }
`,

  // ---- BRAINS ----
  'src/brains/index.js': `
import { ConversationBrain } from './conversation.js';
import { ModerationBrain } from './moderation.js';
import { CoachBrain } from './coach.js';
export const brains = {
  conversation: ConversationBrain,
  moderation: ModerationBrain,
  coach: CoachBrain,
};
export const defaultBrain = 'conversation';
export function getBrain(name) {
  const BrainClass = brains[name];
  if (!BrainClass) return brains[defaultBrain];
  return BrainClass;
}
`,

  'src/brains/conversation.js': `
import { getSystemPrompt } from '../../personality.js';
export class ConversationBrain {
  static getConfig() {
    return { systemPrompt: getSystemPrompt(), temperature: 0.7, maxTokens: 1024 };
  }
  static async processResponse(reply, context) { return reply; }
  static async score({ message }) { return { score: 50, confidence: 0.8, priority: 1, cost: 1 }; }
}
`,

  'src/brains/moderation.js': `
export class ModerationBrain {
  static getConfig() {
    return {
      systemPrompt: \`You are a moderation AI. Analyze the user's message for toxicity, spam, and harmful content.
Return a JSON object with fields: toxic, spam, severity, reason.\`,
      temperature: 0.1,
      maxTokens: 150,
    };
  }
  static async processResponse(reply, context) {
    try { return JSON.parse(reply); } catch (e) { return { toxic: false, spam: false, severity: 0, reason: 'parse error' }; }
  }
  static async score({ message }) {
    const lower = message.toLowerCase();
    const toxicWords = ['hate','kill','stupid','idiot','dumb','fuck','shit','damn'];
    let count = 0;
    for (const w of toxicWords) if (lower.includes(w)) count++;
    const score = Math.min(count * 20, 100);
    return { score, confidence: count > 0 ? 0.7 : 0.2, priority: 2, cost: 0.5 };
  }
}
`,

  'src/brains/coach.js': `
export class CoachBrain {
  static getConfig() {
    return {
      systemPrompt: \`You are a coach for Naraka Bladepoint. Provide concise, actionable advice on combos, weapons, movement, and strategy.\`,
      temperature: 0.5,
      maxTokens: 1024,
    };
  }
  static async score({ message }) {
    const lower = message.toLowerCase();
    const keywords = ['naraka','weapon','combo','blade','hero','skill','ability','damage','heal','attack','dodge','parry'];
    let score = 0;
    for (const kw of keywords) if (lower.includes(kw)) score += 15;
    score = Math.min(score, 100);
    return { score, confidence: score > 30 ? 0.8 : 0.3, priority: 1.5, cost: 1 };
  }
}
`,

  'src/brains/router.js': `
import { brains } from './index.js';
import { getRedis } from '../storage/redis.js';
export async function scoreBrains(channel, user, message, context = {}) {
  const scores = [];
  for (const [name, Brain] of Object.entries(brains)) {
    const scoreFn = Brain.score || (() => ({ score: 0, confidence: 0, priority: 1, cost: 1 }));
    const result = await scoreFn({ channel, user, message, context });
    scores.push({ name, ...result });
  }
  const weighted = scores.map(s => ({
    name: s.name,
    weighted: (s.score || 0) * (s.confidence || 1) * (s.priority || 1) / (s.cost || 1)
  }));
  weighted.sort((a, b) => b.weighted - a.weighted);
  let selected = weighted[0]?.name || 'conversation';
  const redis = getRedis();
  if (redis) {
    const override = await redis.get(\`brain:\${channel}\`);
    if (override && brains[override]) selected = override;
  }
  return selected;
}
`,

  'src/ai/prompt.js': `
import { getSystemPrompt } from '../../personality.js';
export function buildSystemPrompt(channel, user, context = {}) {
  const base = getSystemPrompt();
  let extra = '';
  if (context.game) extra += \`\\nCurrent game: \${context.game}\`;
  if (context.recentEvents) extra += \`\\nRecent events: \${context.recentEvents}\`;
  return \`\${base}\${extra}\`;
}
export function buildUserPrompt(message, username, history = []) {
  let prompt = '';
  if (history.length) {
    prompt += 'Previous conversation:\\n';
    for (const entry of history.slice(-5)) {
      const displayName = entry.username || (entry.role === 'user' ? 'User' : 'Bot');
      prompt += \`\${displayName}: \${entry.content}\\n\`;
    }
  }
  prompt += \`\\n\${username}: \${message}\`;
  return prompt;
}
`,

  // ---- BUILTINS (fixed apostrophe) ----
  'src/commands/builtins.js': `
import { registerBuiltin } from './index.js';
import { brains, defaultBrain } from '../brains/index.js';
import { getRedis } from '../storage/redis.js';

registerBuiltin('!help', async (user, channel, client) => {
  const brainList = Object.keys(brains).join(', ');
  return \`Commands: !help, !uptime, !bot, !about, !brain <\${brainList}>, !commands, and custom commands.\`;
}, 'Shows this help');

registerBuiltin('!uptime', async (user, channel, client) => {
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  return \`I've been online for \${hours}h \${minutes}m.\`;
}, 'Shows bot uptime');

registerBuiltin('!bot', async () => {
  return "I'm SweatyClanker, a multi‑brain AI bot powered by DeepSeek!";
}, 'About the bot');

registerBuiltin('!about', async () => {
  return 'I use DeepSeek AI with multiple brains. Source: https://github.com/your/repo';
}, 'About the project');

registerBuiltin('!brain', async (user, channel, client, message) => {
  const parts = message.split(' ');
  if (parts.length < 2) {
    return \`Current brain: default. Available: \${Object.keys(brains).join(', ')}\`;
  }
  const requested = parts[1].toLowerCase();
  if (brains[requested]) {
    const redis = getRedis();
    if (redis) await redis.set(\`brain:\${channel}\`, requested);
    return \`Switching brain to \${requested} mode.\`;
  }
  return \`Brain '\${requested}' not found. Available: \${Object.keys(brains).join(', ')}\`;
}, 'Switch or list brains');

registerBuiltin('!commands', async () => {
  const redis = getRedis();
  if (!redis) return 'No custom commands loaded.';
  const keys = await redis.keys('cmd:*');
  const cmds = await Promise.all(keys.map(async k => {
    const data = await redis.get(k);
    return data ? JSON.parse(data).name : null;
  }));
  const list = cmds.filter(Boolean).join(', ');
  return list ? \`Custom commands: \${list}\` : 'No custom commands.';
}, 'List custom commands');
`,

  // ---- TWITCH PLUGIN ----
  'plugins/twitch/index.js': `
import { TwitchClient } from '../../src/twitch/client.js';
import bus from '../../src/bus/index.js';
import { createLogger } from '../../src/logger/index.js';
const log = createLogger('TWITCH-PLUGIN');
let client = null;
export const manifest = { name: 'twitch', version: '1.0.0', description: 'Twitch IRC integration', dependencies: [] };
export async function register(bus, config) {
  client = new TwitchClient();
  global.twitchClient = client;
  client.on('connected', (addr, port) => {
    log.info(\`Twitch connected to \${addr}:\${port}\`);
    bus.emit('twitch.connected', { addr, port });
  });
  client.on('disconnected', (reason) => {
    log.warn('Twitch disconnected', reason);
    bus.emit('twitch.disconnected', { reason });
  });
  client.on('reconnecting', () => {
    log.warn('Twitch reconnecting');
    bus.emit('twitch.reconnecting');
  });
  client.on('message', (channel, user, message, self) => {
    bus.emit('twitch.message', { channel, user, message, self });
  });
  client.on('usernotice', (channel, user, msg, tags) => {
    bus.emit('twitch.usernotice', { channel, user, msg, tags });
  });
  client.on('clearchat', (channel) => {
    bus.emit('twitch.clearchat', { channel });
  });
  client.on('join', (channel, username, self) => {
    bus.emit('twitch.join', { channel, username, self });
  });
  client.on('part', (channel, username, self) => {
    bus.emit('twitch.part', { channel, username, self });
  });
  await client.connect();
  log.info('Twitch client connected and ready');
  bus.emit('twitch.ready');
}
export async function shutdown() {
  if (client) {
    client.disconnect();
    client = null;
  }
}
`,
};

// ---- Write all files ----
function ensureDirectory(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

for (const [filePath, content] of Object.entries(files)) {
  const dir = path.dirname(filePath);
  ensureDirectory(dir);
  fs.writeFileSync(filePath, content.trimStart(), 'utf8');
  console.log(`Created ${filePath}`);
}

console.log('\n✅ SweatyClanker v3 – All fixes applied!');
console.log('Now run: npm install');
console.log('Then: cp .env.example .env and fill in your credentials.');
console.log('Finally: npm start');
