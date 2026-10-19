
import dotenv from 'dotenv';
import { createLogger } from '../logger/index.js';
dotenv.config();

const log = createLogger('CONFIG');

const requiredVars = {
  TWITCH_USERNAME: 'Twitch bot account name',
  TWITCH_CLIENT_ID: 'Twitch application Client ID',
  TWITCH_CLIENT_SECRET: 'Twitch application Client Secret',
  JOIN_CHANNELS: 'Comma-separated list of channels to join',
};

const missing = Object.keys(requiredVars).filter(key => !process.env[key]);
if (missing.length) {
  log.error('Missing required environment variables:');
  missing.forEach(key => log.error(`  - ${key}: ${requiredVars[key]}`));
  process.exit(1);
}
if (!String(process.env.DEEPSEEK_API_KEY || '').trim() && !String(process.env.OPENAI_API_KEY || '').trim()) {
  log.error('Set at least one AI provider key: DEEPSEEK_API_KEY or OPENAI_API_KEY');
  process.exit(1);
}

const optional = {
  DEEPSEEK_API_KEY: '',
  OPENAI_API_KEY: '',
  OPENAI_MODEL: 'gpt-4.1-mini',
  AI_PROVIDER_ORDER: 'deepseek,openai',
  AI_FAILBACK_INTERVAL_MS: 60000,
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
  AUTO_CHAT_TICK_SECONDS: 30,
  AUTO_CHAT_MIN_QUIET_SECONDS: 90,
  AUTO_CHAT_MAX_QUIET_SECONDS: 360,
  AUTO_CHAT_BOT_GAP_SECONDS: 120,
  AUTO_CHAT_RECENT_BOT_WINDOW_SECONDS: 600,
  AUTO_CHAT_REQUIRE_LIVE: 'true',
  ANALYTICAL_MOMENT_COOLDOWN_SECONDS: 90,
  ANALYTICAL_AUTO_COMMENT_ENABLED: 'true',
  AUTO_WELCOME: 'true',
  WELCOME_ON_JOIN: 'true',
  JOIN_WELCOME_BATCH_MS: 2500,
  JOIN_WELCOME_DEDUPE_MINUTES: 360,
  JOIN_WELCOME_WARMUP_SECONDS: 60,
  SALES_ENGINE_ENABLED: 'true',
  SALES_VIEWER_COOLDOWN_DAYS: 30,
  SALES_CHANNEL_COOLDOWN_MINUTES: 15,
  SALES_CONVERSION_COOLDOWN_DAYS: 30,
  SALES_OFFERS_JSON: '',
  BRANDED_CONTENT_DISCLOSURE_CONFIRMED: 'false',
  RETENTION_ENGINE_ENABLED: 'true',
  RETENTION_MIN_SCORE: 0.56,
  RETENTION_MIN_PROMPT_GAP_SECONDS: 45,
  RETENTION_REPLY_WINDOW_SECONDS: 120,
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
  AI_FAILBACK_INTERVAL_MS: Number,
  COOLDOWN_DURATION: Number,
  USER_COOLDOWN: Number,
  MAX_REPEAT_MESSAGES: Number,
  MAX_CAPS_RATIO: Number,
  AUTO_MESSAGE_INTERVAL: Number,
  AUTO_QUIET_THRESHOLD: Number,
  AUTO_CHAT_TICK_SECONDS: Number,
  AUTO_CHAT_MIN_QUIET_SECONDS: Number,
  AUTO_CHAT_MAX_QUIET_SECONDS: Number,
  AUTO_CHAT_BOT_GAP_SECONDS: Number,
  AUTO_CHAT_RECENT_BOT_WINDOW_SECONDS: Number,
  ANALYTICAL_MOMENT_COOLDOWN_SECONDS: Number,
  JOIN_WELCOME_BATCH_MS: Number,
  JOIN_WELCOME_DEDUPE_MINUTES: Number,
  JOIN_WELCOME_WARMUP_SECONDS: Number,
  SALES_VIEWER_COOLDOWN_DAYS: Number,
  SALES_CHANNEL_COOLDOWN_MINUTES: Number,
  SALES_CONVERSION_COOLDOWN_DAYS: Number,
  RETENTION_MIN_SCORE: Number,
  RETENTION_MIN_PROMPT_GAP_SECONDS: Number,
  RETENTION_REPLY_WINDOW_SECONDS: Number,
  PORT: Number,
  ALLOW_LINKS: Boolean,
  ENABLE_EMOTE_APPENDING: Boolean,
  ENABLE_7TV_EMOTES: Boolean,
  ENABLE_BTTV_EMOTES: Boolean,
  ENABLE_FFZ_EMOTES: Boolean,
  AUTO_MESSAGE_ENABLED: Boolean,
  AUTO_USE_DEEPSEEK: Boolean,
  AUTO_CHAT_REQUIRE_LIVE: Boolean,
  ANALYTICAL_AUTO_COMMENT_ENABLED: Boolean,
  AUTO_WELCOME: Boolean,
  WELCOME_ON_JOIN: Boolean,
  SALES_ENGINE_ENABLED: Boolean,
  BRANDED_CONTENT_DISCLOSURE_CONFIRMED: Boolean,
  RETENTION_ENGINE_ENABLED: Boolean,
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
  openai: {
    apiKey: env.OPENAI_API_KEY,
    model: env.OPENAI_MODEL,
    timeoutMs: env.AI_TIMEOUT_MS,
  },
  ai: {
    providerOrder: (env.AI_PROVIDER_ORDER || 'deepseek,openai')
      .split(',').map(name => name.trim().toLowerCase())
      .filter((name, index, names) => ['deepseek', 'openai'].includes(name) && names.indexOf(name) === index),
    failbackIntervalMs: env.AI_FAILBACK_INTERVAL_MS,
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
    tickSeconds: env.AUTO_CHAT_TICK_SECONDS,
    minQuietSeconds: env.AUTO_CHAT_MIN_QUIET_SECONDS,
    maxQuietSeconds: env.AUTO_CHAT_MAX_QUIET_SECONDS,
    botGapSeconds: env.AUTO_CHAT_BOT_GAP_SECONDS,
    recentBotWindowSeconds: env.AUTO_CHAT_RECENT_BOT_WINDOW_SECONDS,
    requireLive: env.AUTO_CHAT_REQUIRE_LIVE,
    analyticalCooldownSeconds: env.ANALYTICAL_MOMENT_COOLDOWN_SECONDS,
    analyticalAutoComment: env.ANALYTICAL_AUTO_COMMENT_ENABLED,
    welcome: env.AUTO_WELCOME,
    welcomeOnJoin: env.WELCOME_ON_JOIN,
    joinWelcomeBatchMs: env.JOIN_WELCOME_BATCH_MS,
    joinWelcomeDedupeMinutes: env.JOIN_WELCOME_DEDUPE_MINUTES,
    joinWelcomeWarmupSeconds: env.JOIN_WELCOME_WARMUP_SECONDS,
  },
  sales: {
    enabled: env.SALES_ENGINE_ENABLED,
    viewerCooldownDays: env.SALES_VIEWER_COOLDOWN_DAYS,
    channelCooldownMinutes: env.SALES_CHANNEL_COOLDOWN_MINUTES,
    conversionCooldownDays: env.SALES_CONVERSION_COOLDOWN_DAYS,
    offersJson: env.SALES_OFFERS_JSON || '',
    brandedContentConfirmed: env.BRANDED_CONTENT_DISCLOSURE_CONFIRMED,
  },
  retention: {
    enabled: env.RETENTION_ENGINE_ENABLED,
    minScore: env.RETENTION_MIN_SCORE,
    minPromptGapSeconds: env.RETENTION_MIN_PROMPT_GAP_SECONDS,
    replyWindowSeconds: env.RETENTION_REPLY_WINDOW_SECONDS,
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
