
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
};

const missing = Object.keys(requiredVars).filter(key => !process.env[key]);
if (missing.length) {
  log.error('Missing required environment variables:');
  missing.forEach(key => log.error(`  - ${key}: ${requiredVars[key]}`));
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
  EVENTSUB_SECRET: '',
  ADMIN_API_KEY: '',
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
for (const [key, def] of Object.entries(optional)) {
  env[key] = process.env[key] ?? def;
}
for (const key of Object.keys(requiredVars)) {
  env[key] = process.env[key];
}

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

const publicUrl = env.PUBLIC_URL || (process.env.RENDER_EXTERNAL_HOSTNAME
  ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`
  : `http://localhost:${env.PORT}`);

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
    adminApiKey: env.ADMIN_API_KEY || '',
  },
  eventsub: {
    secret: env.EVENTSUB_SECRET,
    wssUrl: env.EVENTSUB_WSS_URL || 'wss://eventsub.wss.twitch.tv/ws',
  },
};

log.info('✅ Configuration validated successfully');
