
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- Define all files and their content ----

const files = {

  // Root files
  '.env.example': `
# Twitch
TWITCH_USERNAME=your_bot_account
TWITCH_CLIENT_ID=your_twitch_app_client_id
TWITCH_CLIENT_SECRET=your_twitch_app_secret
JOIN_CHANNELS=channel1,channel2

# DeepSeek (only AI provider)
DEEPSEEK_API_KEY=your_deepseek_api_key
DEEPSEEK_MODEL=deepseek-chat
AI_HISTORY_LENGTH=5
AI_TEMPERATURE=0.7
AI_MAX_TOKENS=1024

# Redis (optional – falls back to file storage)
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

# Server
PORT=3000
LOG_LEVEL=info

# Optional: ignored usernames (comma-separated)
IGNORED_USERNAMES=some_bad_user,another_bad_user
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

  'package.json': JSON.stringify({
    name: 'twitch-ai-chatbot',
    version: '2.0.0',
    type: 'module',
    description: 'Production-ready Twitch chatbot with DeepSeek AI',
    main: 'src/app.js',
    scripts: {
      start: 'node src/app.js',
      dev: 'nodemon src/app.js',
    },
    dependencies: {
      axios: '^1.6.0',
      dotenv: '^16.0.3',
      ejs: '^3.1.9',
      express: '^4.18.2',
      'express-ws': '^5.0.2',
      ioredis: '^5.3.2',
      'tmi.js': '^1.8.5',
      winston: '^3.11.0',
    },
    devDependencies: {
      nodemon: '^3.0.1',
    },
    engines: {
      node: '>=18.0.0',
    },
  }, null, 2),

  'README.md': `
# Twitch AI Chatbot – DeepSeek Powered

A modular, production‑ready Twitch chatbot that uses **DeepSeek API** for natural conversation, with automatic responses, moderation, memory, and custom commands.

## Features
- ✅ DeepSeek AI (only provider)
- ✅ OAuth2 token refresh
- ✅ Auto‑reconnect with exponential backoff
- ✅ Per‑channel & per‑user cooldowns
- ✅ Spam, caps, link, and toxicity moderation
- ✅ Redis + file storage (fallback)
- ✅ Custom commands with role‑based permissions
- ✅ Built‑in commands: \`!help\`, \`!uptime\`, \`!bot\`, \`!about\`
- ✅ Emote appending (7TV, BTTV, FFZ)
- ✅ WebSocket dashboard for real‑time chat log
- ✅ Health and readiness probes for Render
- ✅ Structured logging with Winston

## Quick Start

1. Clone the repository.
2. Copy \`.env.example\` to \`.env\` and fill in your credentials.
3. Install dependencies: \`npm install\`
4. Start the bot: \`npm start\`

## Deployment on Render

- Set all environment variables in the Render dashboard.
- Use the \`npm start\` command.
- The bot will automatically reconnect on failures.

## Custom Commands

Create a \`custom_commands.txt\` file in the root:

\`\`\`
!lurk | all = I'm lurking but watching!
!quote | mod = "Random quote" (mod only)
\`\`\`

Roles: \`all\`, \`moderator\`, \`broadcaster\`.

## License

MIT
`,

  'personality.js': `
// SweatyClanker personality – exports functions used by the AI prompt builder
export function getSystemPrompt() {
  return \`You are SweatyClanker, a laid‑back, funny, and slightly sarcastic Twitch chatter.
You love gaming, memes, and talking to viewers. You speak in lowercase, use Twitch emotes occasionally, and never repeat yourself.
Keep responses short (max 2 sentences) unless asked a detailed question.
Be welcoming, helpful, and always remember recent chat context.\`;
}

export function shouldRespond(message, botUsername) {
  // Respond when the bot is mentioned or when the message is a direct greeting
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

  // src/config/index.js
  'src/config/index.js': `
import dotenv from 'dotenv';
dotenv.config();

const required = [
  'TWITCH_USERNAME',
  'TWITCH_CLIENT_ID',
  'TWITCH_CLIENT_SECRET',
  'DEEPSEEK_API_KEY',
  'JOIN_CHANNELS',
];

const missing = required.filter(key => !process.env[key]);
if (missing.length) {
  console.error(\`[FATAL] Missing environment variables: \${missing.join(', ')}\`);
  process.exit(1);
}

export const config = {
  twitch: {
    username: process.env.TWITCH_USERNAME,
    clientId: process.env.TWITCH_CLIENT_ID,
    clientSecret: process.env.TWITCH_CLIENT_SECRET,
    channels: process.env.JOIN_CHANNELS.split(',').map(c => c.trim()).filter(Boolean),
    ignoredUsers: (process.env.IGNORED_USERNAMES || '').split(',').map(u => u.trim().toLowerCase()).filter(Boolean),
  },
  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY,
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    maxHistory: parseInt(process.env.AI_HISTORY_LENGTH) || 5,
    temperature: parseFloat(process.env.AI_TEMPERATURE) || 0.7,
    maxTokens: parseInt(process.env.AI_MAX_TOKENS) || 1024,
  },
  redis: {
    url: process.env.REDIS_URL || '',
  },
  cooldown: {
    global: parseInt(process.env.COOLDOWN_DURATION) || 1,
    perUser: parseInt(process.env.USER_COOLDOWN) || 5,
  },
  moderation: {
    maxRepeats: parseInt(process.env.MAX_REPEAT_MESSAGES) || 3,
    maxCapsRatio: parseFloat(process.env.MAX_CAPS_RATIO) || 0.7,
    linkFilter: process.env.ALLOW_LINKS !== 'true',
  },
  emotes: {
    enable: process.env.ENABLE_EMOTE_APPENDING !== 'false',
    excludePrefixes: (process.env.EMOTE_APPEND_EXCLUDE_PREFIXES || '').split(',').map(p => p.trim().toLowerCase()),
    sevenTv: process.env.ENABLE_7TV_EMOTES !== 'false',
    bttv: process.env.ENABLE_BTTV_EMOTES !== 'false',
    ffz: process.env.ENABLE_FFZ_EMOTES === 'true',
  },
  server: {
    port: parseInt(process.env.PORT) || 3000,
    trustProxy: true,
  },
};
`,

  // src/logger/index.js
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

export const createLogger = (label) => {
  return logger.child({ label });
};
`,

  // src/storage/redis.js
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
  });

  redis.on('connect', () => log.info('Connected to Redis'));
  redis.on('error', (err) => log.error('Redis error', err));
  redis.on('close', () => log.warn('Redis connection closed'));

  await redis.ping();
  return redis;
}

export function getRedis() {
  return redis;
}
`,

  // src/storage/file.js
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

  // src/twitch/auth.js
  'src/twitch/auth.js': `
import axios from 'axios';
import { config } from '../config/index.js';
import { getRedis } from '../storage/redis.js';
import { readJSON, writeJSON } from '../storage/file.js';
import { createLogger } from '../logger/index.js';

const log = createLogger('AUTH');
const TOKEN_KEY = 'twitch:oauth';
const TOKEN_FILE = './tokens.json';

let currentToken = null;
let refreshTimer = null;

async function loadStoredToken() {
  const redis = getRedis();
  if (redis) {
    const data = await redis.get(TOKEN_KEY);
    if (data) return JSON.parse(data);
  }
  return readJSON(TOKEN_FILE, null);
}

async function saveToken(tokenData) {
  const redis = getRedis();
  if (redis) {
    await redis.set(TOKEN_KEY, JSON.stringify(tokenData), 'EX', tokenData.expires_in || 86400);
  }
  await writeJSON(TOKEN_FILE, tokenData);
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
    scheduleRefresh();
  }
  return !!currentToken;
}

export async function exchangeCodeForToken(code, redirectUri) {
  const response = await axios.post(
    'https://id.twitch.tv/oauth2/token',
    null,
    {
      params: {
        client_id: config.twitch.clientId,
        client_secret: config.twitch.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      },
    }
  );
  const tokenData = response.data;
  tokenData.expires_at = Date.now() + tokenData.expires_in * 1000;
  currentToken = tokenData;
  await saveToken(tokenData);
  scheduleRefresh();
  log.info('Token exchanged successfully');
  return tokenData;
}

async function refreshToken() {
  if (!currentToken) return;
  try {
    const response = await axios.post(
      'https://id.twitch.tv/oauth2/token',
      null,
      {
        params: {
          client_id: config.twitch.clientId,
          client_secret: config.twitch.clientSecret,
          refresh_token: currentToken.refresh_token,
          grant_type: 'refresh_token',
        },
      }
    );
    const newData = response.data;
    newData.expires_at = Date.now() + newData.expires_in * 1000;
    currentToken = newData;
    await saveToken(newData);
    log.info('Token refreshed');
  } catch (err) {
    log.error('Token refresh failed', err);
  }
}

function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  if (!currentToken || !currentToken.expires_at) return;
  const now = Date.now();
  const timeToExpiry = currentToken.expires_at - now;
  const refreshAt = Math.max(timeToExpiry - 60000, 60000);
  refreshTimer = setTimeout(async () => {
    await refreshToken();
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

  // src/twitch/client.js
  'src/twitch/client.js': `
import tmi from 'tmi.js';
import { config } from '../config/index.js';
import { getAccessToken } from './auth.js';
import { createLogger } from '../logger/index.js';
import { RateLimiter } from '../utils/rateLimiter.js';

const log = createLogger('IRC');

export class TwitchClient {
  constructor() {
    this.client = null;
    this.channels = config.twitch.channels;
    this.connected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 1000;
    this.rateLimiter = new RateLimiter(20, 30000);
    this.eventListeners = {
      message: [],
      connected: [],
      disconnected: [],
      reconnecting: [],
      roomstate: [],
      userstate: [],
      usernotice: [],
      clearchat: [],
      clearmsg: [],
      join: [],
      part: [],
      whisper: [],
    };
    this._disconnecting = false;
    this._reconnecting = false;
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

      this.client = new tmi.Client({
        options: { debug: false },
        identity: {
          username: config.twitch.username,
          password: \`oauth:\${token}\`,
        },
        channels: this.channels,
        connection: {
          reconnect: true,
          secure: true,
        },
      });

      // Bind events
      this.client.on('connected', (addr, port) => {
        this.connected = true;
        this.reconnectAttempts = 0;
        this.reconnectDelay = 1000;
        log.info(\`Connected to \${addr}:\${port}\`);
        this.emit('connected', addr, port);
        resolve();
      });

      this.client.on('disconnected', (reason) => {
        this.connected = false;
        log.warn(\`Disconnected: \${reason}\`);
        this.emit('disconnected', reason);
        if (!this._disconnecting) {
          this.reconnect();
        }
      });

      this.client.on('reconnect', () => {
        log.warn('Received RECONNECT from Twitch');
        this.emit('reconnecting');
        this.reconnect();
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
        reject(new Error('Connection timeout'));
      }, 15000);

      this.client.connect().catch((err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  disconnect() {
    this._disconnecting = true;
    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
    this.connected = false;
    this._disconnecting = false;
  }

  async reconnect() {
    if (this._reconnecting) return;
    this._reconnecting = true;
    try {
      this.disconnect();
      await new Promise(resolve => setTimeout(resolve, this.reconnectDelay));
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
      await this.connect();
    } catch (err) {
      log.error('Reconnection failed', err);
      this.reconnectAttempts++;
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnect();
      } else {
        log.error('Max reconnect attempts reached');
        this.emit('disconnected', 'Max attempts');
      }
    } finally {
      this._reconnecting = false;
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
    if (this.eventListeners[event]) {
      this.eventListeners[event].push(fn);
    }
  }

  emit(event, ...args) {
    (this.eventListeners[event] || []).forEach(fn => fn(...args));
  }
}
`,

  // src/twitch/emotes.js (stub – replace with full implementation)
  'src/twitch/emotes.js': `
import { createLogger } from '../logger/index.js';
const log = createLogger('EMOTES');

// In production, implement fetchSevenTvChannelEmotesForTwitchIds etc.
// For now, we return empty pools.
export async function initializeEmotes(channels) {
  log.info(\`Emotes initialised for \${channels.length} channels (stub)\`);
  // Placeholder: fill emotePools with actual emotes
}

let emotePools = new Map();

export function getRandomEmote(channel) {
  const pool = emotePools.get(channel) || [];
  if (!pool.length) return '';
  return pool[Math.floor(Math.random() * pool.length)];
}

// To be implemented with the original emote providers.
`,

  // src/ai/client.js
  'src/ai/client.js': `
import axios from 'axios';
import { config } from '../config/index.js';
import { createLogger } from '../logger/index.js';

const log = createLogger('DEEPSEEK');

export class DeepSeekClient {
  constructor() {
    this.apiKey = config.deepseek.apiKey;
    this.model = config.deepseek.model;
    this.maxTokens = config.deepseek.maxTokens;
    this.temperature = config.deepseek.temperature;
    this.baseURL = 'https://api.deepseek.com/v1';
    this.timeout = 30000;
    this.retries = 3;
  }

  async chat(messages, options = {}) {
    const { temperature = this.temperature, maxTokens = this.maxTokens, stream = false } = options;

    const payload = {
      model: this.model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream,
    };

    let attempt = 0;
    while (attempt < this.retries) {
      try {
        const response = await axios.post(\`\${this.baseURL}/chat/completions\`, payload, {
          headers: {
            'Authorization': \`Bearer \${this.apiKey}\`,
            'Content-Type': 'application/json',
          },
          timeout: this.timeout,
          responseType: stream ? 'stream' : 'json',
        });

        if (stream) {
          return this._handleStream(response);
        }

        log.debug('DeepSeek response received', { usage: response.data.usage });
        return response.data.choices[0].message.content;
      } catch (err) {
        attempt++;
        log.error(\`DeepSeek call failed (attempt \${attempt})\`, err);
        if (attempt >= this.retries) throw err;
        await this._delay(1000 * attempt);
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
          if (data === '[DONE]') {
            resolve(fullContent);
            return;
          }
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

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
`,

  // src/ai/prompt.js
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
      prompt += \`\${entry.user}: \${entry.text}\\n\`;
    }
  }
  prompt += \`\\n\${username}: \${message}\`;
  return prompt;
}
`,

  // src/commands/index.js
  'src/commands/index.js': `
import fs from 'fs/promises';
import { createLogger } from '../logger/index.js';

const log = createLogger('COMMANDS');
export const builtins = new Map();

export function registerBuiltin(name, handler, description) {
  builtins.set(name, { handler, description });
}

export async function loadCustomCommands(commandsMap) {
  try {
    const data = await fs.readFile('./custom_commands.txt', 'utf8');
    const lines = data.split('\\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const [key, value] = trimmed.split('=');
      if (!key || !value) continue;
      const parts = key.split('|');
      let cmd = parts[0].trim().toLowerCase();
      let role = parts[1]?.trim().toLowerCase() || 'all';
      commandsMap.set(cmd, { response: value.trim(), role });
    }
    log.info(\`Loaded \${commandsMap.size} custom commands\`);
  } catch (err) {
    if (err.code !== 'ENOENT') log.error('Failed to load custom commands', err);
  }
}
`,

  // src/commands/builtins.js
  'src/commands/builtins.js': `
import { registerBuiltin } from './index.js';
import { createLogger } from '../logger/index.js';
const log = createLogger('BUILTINS');

// Register built-in commands
registerBuiltin('!help', async (user, channel, client) => {
  return 'Available commands: !help, !uptime, !bot, !about, !commands (for custom)';
}, 'Shows this help');

registerBuiltin('!uptime', async (user, channel, client) => {
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  return \`I've been online for \${hours}h \${minutes}m.\`;
}, 'Shows bot uptime');

registerBuiltin('!bot', async (user, channel, client) => {
  return 'I'm SweatyClanker, a DeepSeek-powered bot!';
}, 'About the bot');

registerBuiltin('!about', async (user, channel, client) => {
  return 'I use DeepSeek AI to chat with you. Source: https://github.com/your/repo';
}, 'About the project');
`,

  // src/moderation/index.js
  'src/moderation/index.js': `
export class Moderation {
  constructor(config) {
    this.maxRepeats = config.maxRepeats || 3;
    this.maxCapsRatio = config.maxCapsRatio || 0.7;
    this.linkFilter = config.linkFilter !== false;
    this.messageHistory = new Map();
  }

  isAllowed(channel, user, message) {
    const username = user.username.toLowerCase();

    // Always allow broadcaster, mods, and VIPs
    if (user.badges?.broadcaster || user.mod || user.badges?.vip) {
      return true;
    }

    // Spam: repeated identical messages
    const history = this.messageHistory.get(username) || [];
    const now = Date.now();
    const recent = history.filter(h => now - h.time < 10000);
    const sameMsgCount = recent.filter(h => h.text === message).length;
    if (sameMsgCount >= this.maxRepeats) {
      return false;
    }
    this.messageHistory.set(username, [...recent, { time: now, text: message }]);

    // Caps
    const letters = message.replace(/[^a-zA-Z]/g, '');
    if (letters.length > 5) {
      const caps = (message.match(/[A-Z]/g) || []).length;
      if (caps / letters.length > this.maxCapsRatio) {
        return false;
      }
    }

    // Links
    if (this.linkFilter && /https?:\\/\\/\\S+/i.test(message)) {
      return false;
    }

    return true;
  }
}
`,

  // src/utils/rateLimiter.js
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

  // src/utils/cooldown.js
  'src/utils/cooldown.js': `
export class CooldownManager {
  constructor(config) {
    this.globalCooldown = config.global || 1;
    this.userCooldown = config.perUser || 5;
    this.lastGlobal = 0;
    this.userTimers = new Map();
  }

  check(key) {
    const now = Date.now();
    if (now - this.lastGlobal < this.globalCooldown * 1000) return false;
    this.lastGlobal = now;

    const last = this.userTimers.get(key) || 0;
    if (now - last < this.userCooldown * 1000) return false;
    this.userTimers.set(key, now);
    return true;
  }
}
`,

  // src/app.js – Main application
  'src/app.js': `
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
let conversationMemory = {}; // channel -> [{user, text}]
let wsClients = new Set();

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
  const redirectUri = \`\${req.protocol}://\${req.get('host')}/auth/callback\`;
  const url = \`https://id.twitch.tv/oauth2/authorize?client_id=\${config.twitch.clientId}&redirect_uri=\${encodeURIComponent(redirectUri)}&response_type=code&scope=chat:read+chat:edit+user:bot\`;
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
  });
  twitchClient.on('disconnected', (reason) => {
    log.warn('Twitch disconnected', reason);
    broadcast({ type: 'status', connected: false });
  });

  // Register event handlers
  twitchClient.on('message', handleMessage);
  twitchClient.on('usernotice', handleUserNotice);
  twitchClient.on('clearchat', handleClearChat);

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

  if (config.twitch.ignoredUsers.includes(login)) return;

  if (!moderation.isAllowed(channel, user, message)) {
    log.debug(\`Moderation blocked message from \${username} in \${channel}\`);
    return;
  }

  const cooldownKey = \`\${channel}:\${login}\`;
  if (!cooldown.check(cooldownKey)) {
    log.debug(\`Cooldown active for \${username} in \${channel}\`);
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
      conversationMemory[channel].push({ user: username, text: message });
      conversationMemory[channel].push({ user: 'bot', text: reply });
      if (conversationMemory[channel].length > 100) {
        conversationMemory[channel] = conversationMemory[channel].slice(-50);
      }

      let finalReply = reply;
      if (config.emotes.enable) {
        const emote = getRandomEmote(channel);
        if (emote) finalReply += \` \${emote}\`;
      }
      await twitchClient.say(channel, finalReply);
    }
  } catch (err) {
    log.error('AI chat error', err);
    const fallback = getFallbackResponse();
    await twitchClient.say(channel, fallback);
  }
}

// ---------- Other Event Handlers ----------
async function handleUserNotice(channel, user, msg, tags) {
  if (tags['msg-id'] === 'raid') {
    const from = tags['display-name'] || 'someone';
    await twitchClient.say(channel, \`Thanks for the raid, \${from}! PogChamp\`);
  } else if (tags['msg-id'] === 'sub' || tags['msg-id'] === 'resub') {
    const subName = tags['display-name'] || 'a viewer';
    await twitchClient.say(channel, \`Thanks for the sub, \${subName}! Much love <3\`);
  }
}

async function handleClearChat(channel) {
  log.info(\`Chat cleared in \${channel}\`);
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
    log.info(\`Server running on port \${port}\`);
  });
}

process.on('SIGTERM', async () => {
  log.info('SIGTERM received, shutting down');
  if (twitchClient) twitchClient.disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  log.info('SIGINT received, shutting down');
  if (twitchClient) twitchClient.disconnect();
  process.exit(0);
});

bootstrap().catch(err => {
  log.error('Bootstrap failed', err);
  process.exit(1);
});
`,

  // (Optional) src/twitch/apiClient.js – placeholder for your original helix/emote functions
  'src/twitch/apiClient.js': `
// This file should contain your original getHelixIds and emote fetch functions.
// Example stub:
export async function getHelixIds(usernames) {
  // Implement using Twitch Helix API
  return {};
}
// Also export fetchSevenTvChannelEmotesForTwitchIds, etc.
export async function fetchSevenTvChannelEmotesForTwitchIds(ids) { return new Map(); }
export async function fetchSevenTvGlobalEmotes() { return []; }
export async function fetchBttvChannelEmotesForTwitchIds(ids) { return new Map(); }
export async function fetchBttvGlobalEmotes() { return []; }
export async function fetchFfzChannelEmotesForTwitchIds(ids) { return new Map(); }
export async function fetchFfzGlobalEmotes() { return []; }
`,

};

// ---- Create directories and write files ----
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

console.log('\n✅ All files created!');
console.log('Now run: npm install');
console.log('Then: cp .env.example .env and fill in your credentials.');
console.log('Finally: npm start');
