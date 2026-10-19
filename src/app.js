
import express from 'express';
import expressWs from 'express-ws';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config/index.js';
import { logger, createLogger } from './logger/index.js';
import { connectRedis, getRedis } from './storage/redis.js';
import { initAuth, exchangeCodeForToken, isAuthorized, BOT_SCOPES, configuredBotLogin, getAuthPersistenceStatus } from './twitch/auth.js';
import { createAIClient } from './ai/client.js';
import { buildUserPrompt } from './ai/prompt.js';
import { builtins, loadCustomCommands, saveCustomCommand, deleteCustomCommand } from './commands/index.js';
import './commands/builtins.js';
import { Moderation } from './moderation/index.js';
import { CooldownManager } from './utils/cooldown.js';
import { initializeEmotes, getRandomEmote, setEmotePools } from './twitch/emotes.js';
import { shouldRespond, getFallbackResponse, getContextualFallbackResponse } from '../personality.js';
import { metrics as promMetrics, getMetrics } from './utils/metrics.js';
import { getBrain } from './brains/index.js';
import { scoreBrains } from './brains/router.js';
import { enqueueTask, startWorker, drainQueues } from './queue/index.js';
import { enabledWorkerQueues, estimatedMonthlyIdlePolls, workerRedisBudget } from './queue/workerPolicy.js';
import { jobHandlers } from './queue/handlers.js';
import bus from './bus/index.js';
import { loadPlugins } from './plugins/index.js';
import { ConversationStore } from './memory/conversationStore.js';
import { ProfileStore } from './memory/profileStore.js';
import { MessageQueue } from './queue/messageQueue.js';
import { EventSubClient } from './twitch/eventsub.js';
import { PollinationsClient } from './media/providers.js';
import { writeFile } from 'fs/promises';
import { randomBytes } from 'crypto';
import { HighlightDetector } from './highlights/detector.js';
import { IncomingMessageDeduper } from './chat/incomingDeduper.js';
import { nextViewerProfile, shouldProactivelyWelcome, shouldOfferFollow, followLineFor, shouldOfferSubscription, subscriptionLineFor, firstChatInstruction } from './chat/viewerEngagement.js';
import { ProactiveWelcomeLimiter } from './chat/proactiveWelcomeLimiter.js';
import { StreamMomentTracker } from './chat/streamMomentTracker.js';
import { AnalyticalMomentGate } from './chat/analyticalMomentGate.js';
import { quietSpeakProbability, chooseQuietMode, quietPrompt } from './chat/quietChatterModel.js';
import { EngagementAttribution } from './chat/engagementAttribution.js';
import { JoinWelcomeBatcher } from './chat/joinWelcomeBatcher.js';
import { shouldWelcomeJoin } from './chat/joinWelcomePolicy.js';
import { youtubeAuthUrl, exchangeYouTubeCode } from './social/youtubeAuth.js';
import { CommerceEngine } from './commerce/engine.js';
import { ConversationRetentionEngine } from './chat/conversationRetention.js';
import { LurkerActivationEngine } from './chat/lurkerActivation.js';
import { detectLanguage, languageInstruction, localizedGenericFallback } from './chat/language.js';

const log = createLogger('APP');
const app = express();
const wsInstance = expressWs(app);
app.set('trust proxy', config.server.trustProxy || 1);

let botInitialized = false;
let ai = null;
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
let highlightDetector = null;
const incomingDeduper = new IncomingMessageDeduper();
const streamMomentTracker = new StreamMomentTracker();
const engagementAttribution = new EngagementAttribution();
const analyticalMomentGate = new AnalyticalMomentGate({
  cooldownMs: config.auto.analyticalCooldownSeconds * 1000,
  minScore: 72,
});
const commerceEngine = new CommerceEngine({ enabled: config.sales.enabled });
const retentionEngine = new ConversationRetentionEngine({
  enabled: config.retention.enabled,
  minScore: config.retention.minScore,
  minPromptGapMs: config.retention.minPromptGapSeconds * 1000,
  replyWindowMs: config.retention.replyWindowSeconds * 1000,
});
const lurkerActivationEngine = new LurkerActivationEngine();
const joinWelcomeBatcher = new JoinWelcomeBatcher({
  flushMs: config.auto.joinWelcomeBatchMs,
  dedupeMs: config.auto.joinWelcomeDedupeMinutes * 60_000,
  onFlush: async (channel, message) => {
    if (!config.auto.welcomeOnJoin) return;
    if (!messageQueue && global.twitchClient) {
      messageQueue = new MessageQueue(global.twitchClient);
      log.info('Message queue initialized while flushing join welcome');
    }
    if (!messageQueue) {
      log.warn(`Unable to queue join welcome for ${channel}: Twitch client is unavailable`);
      return;
    }

    messageQueue.enqueue(channel, message, {
      priority: 'high',
      onDelivered: () => {
        promMetrics.messagesSent.inc();
        promMetrics.viewerWelcomes.inc();
        log.info(`Join welcome delivered in ${channel}: ${message}`);
      },
    });
    log.info(`Join welcome queued in ${channel}: ${message}`);
  },
});
const proactiveWelcomeLimiter = new ProactiveWelcomeLimiter({
  maxPerWindow: Number(process.env.PROACTIVE_WELCOME_MAX_PER_MINUTE || 3),
  windowMs: 60_000,
});
const publicUrl = config.server.publicUrl || 'http://localhost:3000';

const AUTO_ENABLED = config.auto.enabled;
const AUTO_USE_DEEPSEEK = config.auto.useDeepSeek;
const AUTO_CHAT_TICK_MS = Math.max(10_000, config.auto.tickSeconds * 1000);
const AUTO_CHAT_MIN_QUIET_MS = Math.max(60_000, config.auto.minQuietSeconds * 1000);
const AUTO_CHAT_MAX_QUIET_MS = Math.max(AUTO_CHAT_MIN_QUIET_MS + 60_000, config.auto.maxQuietSeconds * 1000);
const AUTO_CHAT_BOT_GAP_MS = Math.max(60_000, config.auto.botGapSeconds * 1000);
const AUTO_CHAT_RECENT_BOT_WINDOW_MS = Math.max(AUTO_CHAT_BOT_GAP_MS, config.auto.recentBotWindowSeconds * 1000);
const AUTO_WELCOME = config.auto.welcome;
const FALLBACK_MESSAGES = [
  "Quick read, chat: push the next fight or reset and play safe?",
  "Prediction check: clean win next fight or maximum chaos?",
  "What weapon or loadout are you trusting right now?",
  "Rate the last sequence 1–10 — my circuits need a verdict.",
  "What’s one adjustment you’d make before the next fight?",
];
let fallbackIndex = 0;
const oauthStates = new Map();

function requireAdmin(req, res, next) {
  const expected = config.server.adminApiKey;
  if (!expected) return res.status(503).json({ error: 'Admin API is disabled until ADMIN_API_KEY is configured' });
  const header = req.get('authorization') || '';
  const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (supplied !== expected) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

async function createOAuthState() {
  const state = randomBytes(24).toString('hex');
  const redis = getRedis();
  if (redis) await redis.set(`oauth:state:${state}`, '1', 'EX', 600);
  else {
    oauthStates.set(state, Date.now() + 600000);
    const timer = setTimeout(() => oauthStates.delete(state), 600000);
    timer.unref?.();
  }
  return state;
}

async function consumeOAuthState(state) {
  if (!state) return false;
  const redis = getRedis();
  if (redis) {
    const key = `oauth:state:${state}`;
    const exists = await redis.get(key);
    if (!exists) return false;
    await redis.del(key);
    return true;
  }
  const expiresAt = oauthStates.get(state);
  oauthStates.delete(state);
  return Boolean(expiresAt && expiresAt > Date.now());
}

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

app.get('/healthz', (req, res) => res.status(200).send('OK'));
app.get('/livez', (req, res) => res.status(200).send('OK'));
app.get('/readyz', async (req, res) => {
  let attempts = 0;
  while (attempts < 20) {
    const twitchReady = !!global.twitchClient?.connected;
    const redisRequired = process.env.REDIS_REQUIRED === 'true';
    const redisReady = !redisRequired || !!getRedis();
    const aiReady = !!ai;
    const authReady = isAuthorized();
    if (twitchReady && redisReady && aiReady && authReady) {
      return res.status(200).json({
        status: 'ready',
        ai: ai.getHealth(),
        oauthPersistence: getAuthPersistenceStatus(),
      });
    }
    await new Promise(resolve => setTimeout(resolve, 500));
    attempts++;
  }
  res.status(503).json({
    redis: !!getRedis(),
    twitch: global.twitchClient?.connected || false,
    ai: ai ? ai.getHealth() : null,
    auth: isAuthorized(),
    oauthPersistence: getAuthPersistenceStatus(),
  });
});

app.get('/metrics', requireAdmin, async (req, res) => {
  res.set('Content-Type', 'text/plain');
  res.send(await getMetrics());
});

app.get('/api/auth/status', requireAdmin, (req, res) => {
  res.json({
    account: configuredBotLogin(),
    ...getAuthPersistenceStatus(),
  });
});

app.post(
  '/api/ai/verify-credentials',
  requireAdmin,
  rateLimit({ windowMs: 60_000, max: 2, validate: false, standardHeaders: true, legacyHeaders: false }),
  async (req, res) => {
    if (!ai || typeof ai.verifyCredentials !== 'function') {
      return res.status(503).json({ error: 'AI provider router is not ready' });
    }

    try {
      const reports = await ai.verifyCredentials();
      const configured = new Set(reports.filter(report => report.configured).map(report => report.provider));
      const expected = ['deepseek', 'openai'];
      const providers = [
        ...reports,
        ...expected
          .filter(provider => !configured.has(provider))
          .map(provider => ({
            provider,
            configured: false,
            authentication: 'missing',
            httpStatus: null,
          })),
      ];

      res.set('Cache-Control', 'no-store');
      return res.json({
        checkedAt: new Date().toISOString(),
        providers,
        note: 'Checks provider API authentication only; it does not identify the human account owner.',
      });
    } catch {
      return res.status(502).json({ error: 'AI provider verification could not complete' });
    }
  },
);

app.get('/auth/login', async (req, res) => {
  const redirectUri = `${req.protocol}://${req.get('host')}/auth/callback`;
  const state = await createOAuthState();
  const scope = BOT_SCOPES.join(' ');
  const url = `https://id.twitch.tv/oauth2/authorize?client_id=${config.twitch.clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scope)}&state=${state}`;
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.status(400).send('Missing code');
  if (!(await consumeOAuthState(state))) return res.status(400).send('Invalid or expired OAuth state');
  try {
    const redirectUri = `${req.protocol}://${req.get('host')}/auth/callback`;
    await exchangeCodeForToken(code, redirectUri);
    if (!botInitialized) await initializeBot();
    else log.info('Bot already running, skipping re‑initialization');
    res.send(`SweatyClanker bot authorization successful for ${configuredBotLogin()}. You may close this window.`);
  } catch (err) {
    log.error('Auth callback failed', err);
    if (String(err.message || '').includes('Wrong Twitch account authorized')) {
      return res.status(400).send(`Wrong Twitch account. Sign out of the current Twitch account, sign in as ${configuredBotLogin()}, then authorize again.`);
    }
    res.status(500).send('Authorization failed');
  }
});

app.post('/api/youtube/auth-url', requireAdmin, async (req, res) => {
  try {
    const state = await createOAuthState();
    const redirectUri = `${req.protocol}://${req.get('host')}/auth/youtube/callback`;
    res.json({ url: youtubeAuthUrl({ state, redirectUri }) });
  } catch (err) {
    log.error('YouTube auth URL failed', err);
    res.status(500).json({ error: 'Unable to start YouTube authorization' });
  }
});

app.get('/auth/youtube/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.status(400).send('Missing code');
  if (!(await consumeOAuthState(state))) return res.status(400).send('Invalid or expired OAuth state');
  try {
    const redirectUri = `${req.protocol}://${req.get('host')}/auth/youtube/callback`;
    await exchangeYouTubeCode({ code, redirectUri });
    res.send('YouTube authorization successful. You may close this window.');
  } catch (err) {
    log.error('YouTube OAuth callback failed', err);
    res.status(500).send('YouTube authorization failed');
  }
});

app.post('/api/commands', requireAdmin, async (req, res) => {
  const { name, response, role } = req.body;
  if (!name || !response) return res.status(400).json({ error: 'Missing fields' });
  await saveCustomCommand(name, response, role || 'all');
  await loadCustomCommandsIntoMemory();
  res.json({ success: true });
});

app.delete('/api/commands/:name', requireAdmin, async (req, res) => {
  await deleteCustomCommand(req.params.name);
  await loadCustomCommandsIntoMemory();
  res.json({ success: true });
});

app.get('/api/commerce/stats', requireAdmin, async (req, res) => {
  res.json({ offers: commerceEngine.catalog.map(({ id, type, category, title }) => ({ id, type, category, title })), arms: await commerceEngine.stats() });
});

app.get('/api/retention/stats', requireAdmin, async (req, res) => {
  const language = String(req.query?.language || 'global').toLowerCase();
  const strategies = await retentionEngine.stats(language);
  res.json({
    language,
    strategies: strategies.map(row => ({
      ...row,
      observedReplyRate: row.impressions ? row.replies / row.impressions : null,
    })),
    replyWindowSeconds: config.retention.replyWindowSeconds,
    minOpportunityScore: config.retention.minScore,
  });
});

app.get('/api/lurker-activation/stats', requireAdmin, async (req, res) => {
  const channel = String(req.query?.channel || config.twitch.channels[0] || '').replace(/^#?/, '#').toLowerCase();
  const arms = await lurkerActivationEngine.stats(channel);
  res.json({
    channel,
    arms: arms.map(row => ({
      ...row,
      observedPromptSuccessRate: row.impressions ? row.successes / row.impressions : null,
      activatedUsersPerPrompt: row.impressions ? row.activatedUsers / row.impressions : null,
    })),
    note: 'Tracks silent chat-connected users, not confirmed video viewers.',
  });
});

app.post('/api/commerce/conversion', requireAdmin, async (req, res) => {
  const channel = String(req.body?.channel || config.twitch.channels[0] || '').replace(/^#?/, '#').toLowerCase();
  const viewer = String(req.body?.viewer || '').toLowerCase();
  const offerId = String(req.body?.offerId || '');
  if (!viewer || !offerId || !commerceEngine.catalog.some(offer => offer.id === offerId)) {
    return res.status(400).json({ error: 'Valid viewer and offerId required' });
  }
  const result = await commerceEngine.recordConversion({ channel, viewer, expectedOfferId: offerId, value: Number(req.body?.value || 0) });
  promMetrics.commerceConversions.inc({ offer: offerId, source: 'external', attributed: String(Boolean(result.attributed)) });
  if (result.attributed) await ProfileStore.update(channel, viewer, { lastCommercialConversionAt: Date.now() });
  res.json(result);
});

app.post('/api/media/image', requireAdmin, async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt required' });
  try {
    const result = await pollinations.generateImage(prompt);
    const filename = `image-${Date.now()}.png`;
    await writeFile(`public/${filename}`, result.buffer);
    const url = `${publicUrl}/public/${filename}`;
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function generateSpontaneousMessage(channel, mode, streamContext, history, moment) {
  if (!ai || !AUTO_USE_DEEPSEEK) {
    const msg = FALLBACK_MESSAGES[fallbackIndex % FALLBACK_MESSAGES.length];
    fallbackIndex++;
    return msg;
  }

  const systemPrompt = [
    'You are SweatyClanker, a concise Twitch gaming companion.',
    'The channel is quiet, so restart participation without sounding automated or desperate.',
    'Never ask for follows, subs, money, or personal information in an idle message.',
    'Do not claim you saw gameplay unless the supplied context explicitly proves it.',
    'Prefer one useful observation, prediction, or easy question over generic hype.',
    quietPrompt(mode, streamContext),
  ].join(' ');

  const recentChat = history
    .filter(entry => entry.role === 'user')
    .slice(-6)
    .map(entry => `${entry.username || 'viewer'}: ${entry.content}`)
    .join('\n');

  const messages = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: JSON.stringify({
        mode,
        game: streamContext.gameName || null,
        streamTitle: streamContext.streamTitle || null,
        moment,
        recentChat: recentChat || null,
      })
    }
  ];

  try {
    const start = Date.now();
    const reply = await ai.chat(messages, { temperature: mode === 'analysis-recap' ? 0.45 : 0.8, maxTokens: 180 });
    promMetrics.aiLatency.observe((Date.now() - start) / 1000);
    promMetrics.aiCalls.inc();
    return reply;
  } catch (err) {
    log.error('Failed to generate adaptive quiet message', err);
    promMetrics.aiErrors.inc();
    const msg = FALLBACK_MESSAGES[fallbackIndex % FALLBACK_MESSAGES.length];
    fallbackIndex++;
    return msg;
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
      const streamContext = highlightDetector?.getLiveContext(channel) || {};
      if (config.auto.requireLive && !streamContext.live) continue;

      const lastHumanAt = await ConversationStore.getLastActivity(channel);
      const silenceMs = lastHumanAt ? now - lastHumanAt : AUTO_CHAT_MAX_QUIET_MS;
      if (silenceMs < AUTO_CHAT_MIN_QUIET_MS) continue;

      const history = await ConversationStore.getHistory(channel, 40);
      const recentBotEntries = history.filter(entry =>
        (entry.role === 'bot' || entry.role === 'assistant')
        && Number(entry.ts || 0) >= now - AUTO_CHAT_RECENT_BOT_WINDOW_MS
      );
      const lastBotAt = recentBotEntries.reduce((max, entry) => Math.max(max, Number(entry.ts || 0)), 0);
      if (lastBotAt && now - lastBotAt < AUTO_CHAT_BOT_GAP_MS) continue;

      const moment = streamMomentTracker.snapshot(channel, now);
      const recentHumanMessages = history.filter(entry =>
        entry.role === 'user'
        && Number(entry.ts || 0) >= now - 5 * 60_000
      ).length;

      const lurkerSelection = await lurkerActivationEngine.consider({
        channel,
        silenceMs,
        recentHumanMessages,
        recentBotMessages: recentBotEntries.length,
        streamContext,
        moment,
        now,
      });
      if (lurkerSelection.opportunity != null) {
        promMetrics.lurkerActivationOpportunityScore.observe(lurkerSelection.opportunity);
      }
      promMetrics.lurkerSilentUsers.set({ channel }, lurkerSelection.silentUsers || 0);

      if (lurkerSelection.eligible) {
        let activationMsg = lurkerSelection.message.trim();
        if (config.emotes.enable) {
          const emote = getRandomEmote(channel);
          if (emote) activationMsg += ` ${emote}`;
        }

        if (messageQueue) messageQueue.enqueue(channel, activationMsg);
        else await twitchClient.say(channel, activationMsg);

        promMetrics.messagesSent.inc();
        promMetrics.quietMessages.inc();
        promMetrics.lurkerActivationPrompts.inc({ arm: lurkerSelection.arm });
        promMetrics.lurkerActivationBanditScore.observe(lurkerSelection.banditScore);
        await ConversationStore.pushMessage(channel, 'bot', activationMsg);
        await lurkerActivationEngine.recordPrompt({ channel, selection: lurkerSelection, at: now });
        log.info(`Low-pressure silent-user activation prompt sent in ${channel} (arm=${lurkerSelection.arm}, silent=${lurkerSelection.silentUsers}, p=${lurkerSelection.opportunity.toFixed(3)})`);
        continue;
      } else if (lurkerSelection.reason && lurkerSelection.reason !== 'no_silent_users') {
        promMetrics.lurkerActivationSuppressed.inc({ reason: lurkerSelection.reason });
      }

      const probability = quietSpeakProbability({
        silenceMs,
        tickMs: AUTO_CHAT_TICK_MS,
        recentBotMessages: recentBotEntries.length,
        minQuietMs: AUTO_CHAT_MIN_QUIET_MS,
        maxQuietMs: AUTO_CHAT_MAX_QUIET_MS,
      });
      promMetrics.quietSpeakProbability.observe(probability);
      if (Math.random() >= probability) continue;

      const mode = chooseQuietMode({ history, streamContext, moment });
      const msg = await generateSpontaneousMessage(channel, mode, streamContext, history, moment);
      if (!msg) continue;

      let finalMsg = msg.trim();
      if (!finalMsg) continue;
      if (config.emotes.enable) {
        const emote = getRandomEmote(channel);
        if (emote) finalMsg += ` ${emote}`;
      }

      if (messageQueue) messageQueue.enqueue(channel, finalMsg);
      else await twitchClient.say(channel, finalMsg);

      promMetrics.messagesSent.inc();
      promMetrics.quietMessages.inc();
      if (mode === 'analysis-recap') promMetrics.quietAnalysisRecaps.inc();
      else if (mode === 'prediction') promMetrics.quietPredictionPrompts.inc();
      else promMetrics.quietCommunityQuestions.inc();

      await ConversationStore.pushMessage(channel, 'bot', finalMsg);
      engagementAttribution.recordQuiet(channel, mode, Date.now());
      log.info(`Adaptive quiet message sent in ${channel} (mode: ${mode}, p=${probability.toFixed(3)})`);
    }
  }, AUTO_CHAT_TICK_MS);

  log.info(`Adaptive auto-chat started (tick: ${AUTO_CHAT_TICK_MS / 1000}s, quiet range: ${AUTO_CHAT_MIN_QUIET_MS / 1000}-${AUTO_CHAT_MAX_QUIET_MS / 1000}s)`);
}

async function loadCustomCommandsIntoMemory() {
  customCommands = await loadCustomCommands();
}

// ========== HANDLE MESSAGE ==========
async function handleMessage({ channel, user, message, self }) {
  if (self) return;
  if (incomingDeduper.isDuplicate(channel, user)) {
    log.debug(`Skipping duplicate Twitch message ${user?.id || user?.['message-id'] || 'unknown'}`);
    return;
  }
  promMetrics.messagesReceived.inc();
  const username = user['display-name'] || user.username;
  const login = user.username.toLowerCase();
  log.info(`📩 IN: ${username} @ ${channel}: ${message}`);
  const bitsUsed = Number(user.bits || user['bits'] || 0);
  if (bitsUsed > 0) {
    recordNativeCommerceConversion({
      broadcaster_user_login: String(channel || '').replace(/^#/, ''),
      user_login: login,
    }, 'twitch_bits', 'irc_bits').catch(err => log.warn('Bits conversion tracking failed', err.message));
  }
  await ConversationStore.updateLastActivity(channel);
  if (highlightDetector) {
    highlightDetector.observe({ channel, user, message }).catch((err) => log.warn('Highlight observation failed', err.message));
  }
  if (config.twitch.ignoredUsers.includes(login)) return;
  const modResult = moderation.analyze(channel, user, message);
  if (modResult.blocked) {
    log.warn(`Blocked message from ${username} in ${channel}`);
    enqueueTask('moderation-review', { channel, user: username, message, reason: 'rule_blocked' });
    return;
  }
  if (modResult.riskScore > 40) {
    enqueueTask('moderation-review', { channel, user: username, message, riskScore: modResult.riskScore });
  }

  const silentActivation = await lurkerActivationEngine.onMessage({
    channel,
    username: login,
    now: Date.now(),
  });
  if (silentActivation.attributed) {
    promMetrics.lurkerActivations.inc({ arm: silentActivation.arm });
    promMetrics.lurkerActivationLatency.observe(silentActivation.latencyMs / 1000);
  } else if (silentActivation.wasSilent && silentActivation.reason === 'organic_first_chat') {
    promMetrics.lurkerOrganicFirstChats.inc();
  }

  const attributedResponse = engagementAttribution.recordHuman(channel, Date.now());
  if (attributedResponse.quietMode) {
    promMetrics.quietResponses.inc({ mode: attributedResponse.quietMode });
  }
  if (attributedResponse.analytical) {
    promMetrics.analyticalAutoResponses.inc();
  }

  if (!String(message || '').trim().startsWith('!')) {
    const retentionReply = await retentionEngine.recordReply({ channel, viewer: login, at: Date.now() });
    if (retentionReply.attributed) {
      promMetrics.retentionReplies.inc({ strategy: retentionReply.strategy });
      promMetrics.retentionReplyLatency.observe(retentionReply.latencyMs / 1000);
    }
  }

  const moment = streamMomentTracker.observe(channel, { username, message, now: Date.now() });
  promMetrics.streamMomentScore.observe(moment.score);

  // Preserve surrounding chat and track new-viewer engagement without calling out silent lurkers.
  const priorHistory = await ConversationStore.getHistory(channel, config.deepseek.maxHistory);
  const previousProfile = await ProfileStore.get(channel, login);
  const detectedLanguage = detectLanguage(message, previousProfile.preferredLanguage);
  const viewerProfile = nextViewerProfile(previousProfile, message);
  if (detectedLanguage.confidence >= 0.75 || !viewerProfile.preferredLanguage) {
    viewerProfile.preferredLanguage = detectedLanguage.code;
    viewerProfile.languageConfidence = detectedLanguage.confidence;
    viewerProfile.languageUpdatedAt = Date.now();
  }
  const responseLanguage = viewerProfile.preferredLanguage || detectedLanguage.code || 'en';
  await ProfileStore.update(channel, login, viewerProfile);
  await ConversationStore.pushMessage(channel, 'user', message, username);

  const lowerMsg = message.trim().toLowerCase();
  const isCommand = lowerMsg.startsWith('!');
  if (!previousProfile.proactiveOptOut && viewerProfile.proactiveOptOut) {
    promMetrics.viewerOptOuts.inc();
    const response = `@${username} got it — I’ll stay out of your way unless you use a command.`;
    if (messageQueue) messageQueue.enqueue(channel, response);
    else await global.twitchClient.say(channel, response);
    return;
  }
  if (!previousProfile.commercialOptOut && commerceEngine.isOptOut(message)) {
    promMetrics.commerceOptOuts.inc();
    await ProfileStore.update(channel, login, { commercialOptOut: true });
    const response = `@${username} got it — no promo or sales messages from me.`;
    if (messageQueue) messageQueue.enqueue(channel, response);
    else await global.twitchClient.say(channel, response);
    return;
  }
  // Custom commands
  const cmdKey = [...customCommands.keys()].find(cmd => lowerMsg === cmd || lowerMsg.startsWith(cmd + ' '));
  if (cmdKey) {
    log.info(`🔧 Custom command matched: ${cmdKey}`);
    const cmd = customCommands.get(cmdKey);
    const hasPermission = cmd.role === 'all' ||
      (cmd.role === 'moderator' && (user.mod || user.badges?.broadcaster)) ||
      (cmd.role === 'broadcaster' && user.badges?.broadcaster);
    if (hasPermission) {
      const cooldownKey = `${channel}:${login}`;
      if (!cooldown.check(cooldownKey)) {
        log.debug(`Cooldown active for ${username} in ${channel}`);
        return;
      }
      const response = typeof cmd.response === 'function' ? cmd.response(message, user) : cmd.response;
      if (messageQueue) messageQueue.enqueue(channel, response);
      else await global.twitchClient.say(channel, response);
      promMetrics.messagesSent.inc();
      return;
    }
  }
  // Builtin commands
  const builtinKey = lowerMsg.split(' ')[0];
  if (builtins.has(builtinKey)) {
    log.info(`⚡ Built-in command matched: ${builtinKey}`);
    const cmd = builtins.get(builtinKey);
    const cooldownKey = `${channel}:${login}`;
    if (!cooldown.check(cooldownKey)) return;
    const response = await cmd.handler(user, channel, global.twitchClient, message, { highlightDetector });
    if (response) {
      if (messageQueue) messageQueue.enqueue(channel, response);
      else await global.twitchClient.say(channel, response);
      promMetrics.messagesSent.inc();
    }
    return;
  }
  // Media commands
  const mediaCommands = {
    [config.media.imageCommand]: { type: 'image', handler: pollinations.generateImage.bind(pollinations) },
    [config.media.videoCommand]: { type: 'video', handler: pollinations.generateVideo.bind(pollinations) },
    [config.media.ttsCommand]: { type: 'tts', handler: pollinations.generateAudio.bind(pollinations) },
    [config.media.musicCommand]: { type: 'music', handler: pollinations.generateMusic.bind(pollinations) },
  };
  for (const [cmd, { type, handler }] of Object.entries(mediaCommands)) {
    if (lowerMsg.startsWith(cmd)) {
      log.info(`🎨 Media command matched: ${cmd}`);
      const prompt = message.slice(cmd.length).trim();
      if (!prompt) {
        const response = `Usage: ${cmd} <description>`;
        const cooldownKey = `${channel}:${login}`;
        if (!cooldown.check(cooldownKey)) return;
        if (messageQueue) messageQueue.enqueue(channel, response);
        else await global.twitchClient.say(channel, response);
        return;
      }
      const cooldownKey = `${channel}:${login}`;
      if (!cooldown.check(cooldownKey)) return;
      try {
        const result = await handler(prompt);
        const ext = type === 'image' ? 'png' : type === 'video' ? 'mp4' : 'mp3';
        const filename = `media-${Date.now()}.${ext}`;
        await writeFile(`public/${filename}`, result.buffer);
        const url = `${publicUrl}/public/${filename}`;
        const response = `Here's your ${type}: ${url}`;
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
  // AI chat: direct mentions/replies plus low-pressure first-chat welcome.
  const personaNames = [config.twitch.username.toLowerCase(), 'clanker', 'sweaty clanker'];
  const directInteraction = shouldRespond(message, personaNames, user);
  const commercialIntent = !viewerProfile.commercialOptOut && commerceEngine.hasIntent(message);
  const alreadyWelcomedOnJoin = joinWelcomeBatcher.hasWelcomed(channel, login);
  const proactiveWelcomeCandidate = AUTO_WELCOME && !alreadyWelcomedOnJoin && shouldProactivelyWelcome({
    profile: viewerProfile,
    message,
    isCommand,
  });
  const proactiveWelcome = proactiveWelcomeCandidate && proactiveWelcomeLimiter.allow(channel);
  if (proactiveWelcomeCandidate && !proactiveWelcome) promMetrics.proactiveWelcomesSuppressed.inc();

  const analyticalAutoComment = config.auto.analyticalAutoComment
    && !isCommand
    && !directInteraction
    && !proactiveWelcome
    && analyticalMomentGate.allow(channel, moment);

  const shouldReply = directInteraction || proactiveWelcome || analyticalAutoComment || commercialIntent;
  if (!shouldReply || viewerProfile.proactiveOptOut) {
    log.debug('Skipping AI: no direct interaction, eligible first-chat welcome, or analytical moment');
    return;
  }
  const cooldownKey = `${channel}:${login}`;
  if (!cooldown.check(cooldownKey)) return;
  const streamContext = highlightDetector?.getLiveContext(channel) || {};
  const brainName = analyticalAutoComment
    ? 'analyst'
    : await scoreBrains(channel, user, message, { moment, streamContext });
  const Brain = getBrain(brainName);
  const brainConfig = Brain.getConfig({ moment, streamContext });
  const history = priorHistory;
  let systemPrompt = brainConfig.systemPrompt;
  systemPrompt += `\n\n${languageInstruction(responseLanguage)}`;
  if (proactiveWelcome) {
    systemPrompt += `\n\nNEW VIEWER GUIDANCE: ${firstChatInstruction(username, message)}`;
  }
  if (brainName === 'analyst') {
    systemPrompt += `\n\nLIVE CONTEXT: game=${streamContext.gameName || 'unknown'}; title=${streamContext.streamTitle || 'unknown'}; momentScore=${moment.score}; chatSpikeZ=${moment.poissonZ}; recentMessages=${moment.recentMessages}; uniqueUsers=${moment.uniqueUsers}; tacticalHits=${moment.tacticalHits}; excitementHits=${moment.excitementHits}. Treat these as indirect chat signals, not visual proof.`;
  }
  const offerFollow = shouldOfferFollow({
    profile: viewerProfile,
    message,
    directInteraction,
  });
  const growthAt = Date.now();
  const growthCutoff = growthAt - 10 * 60 * 1000;
  const recentHumanTurns = history.filter(entry =>
    entry.role === 'user'
    && String(entry.username || '').toLowerCase() === login
    && Number(entry.ts || 0) >= growthCutoff
  ).length + 1;
  const recentBotReplies = history.filter(entry =>
    (entry.role === 'bot' || entry.role === 'assistant')
    && Number(entry.ts || 0) >= growthCutoff
  ).length;
  const offerSubscription = shouldOfferSubscription({
    profile: viewerProfile,
    message,
    directInteraction,
    isSubscriber: Boolean(user.badges?.subscriber),
    recentHumanTurns,
    recentBotReplies,
  });
  const salesSelection = await commerceEngine.consider({
    channel,
    viewer: login,
    profile: viewerProfile,
    message,
    directInteraction: directInteraction || commercialIntent,
    proactiveWelcome,
    offerFollow,
    now: Date.now(),
  });
  if (!salesSelection.eligible && (directInteraction || commercialIntent)) {
    promMetrics.commerceSuppressed.inc({ reason: salesSelection.reason || 'policy' });
  }
  if (commercialIntent && salesSelection.eligible) {
    const response = `@${username} ${salesSelection.text}`;
    await commerceEngine.recordImpression({ channel, viewer: login, selection: salesSelection });
    promMetrics.commerceImpressions.inc({ offer: salesSelection.offer.id });
    promMetrics.commerceBanditScore.observe(salesSelection.banditScore);
    await ProfileStore.update(channel, login, {
      lastCommercialPromptAt: Date.now(),
      commercialPromptCount: Number(viewerProfile.commercialPromptCount || 0) + 1,
    });
    if (messageQueue) messageQueue.enqueue(channel, response, { priority: 'high' });
    else await global.twitchClient.say(channel, response);
    promMetrics.messagesSent.inc();
    return;
  }
  const retentionSelection = await retentionEngine.select({
    channel,
    viewer: login,
    profile: viewerProfile,
    message,
    directInteraction,
    proactiveWelcome,
    offerFollow,
    offerSubscription,
    salesEligible: salesSelection.eligible,
    history,
    streamContext,
    moment,
    language: responseLanguage,
    now: Date.now(),
  });
  if (retentionSelection.opportunity != null) {
    promMetrics.retentionOpportunityScore.observe(retentionSelection.opportunity);
  }
  if (!retentionSelection.eligible && directInteraction) {
    promMetrics.retentionSuppressed.inc({ reason: retentionSelection.reason || 'policy' });
  }
  if (retentionSelection.eligible) {
    systemPrompt += `\n\nCONVERSATIONAL RETENTION GUIDANCE: ${retentionSelection.instruction} Do not mention retention, engagement scoring, experiments, tracking, or strategy selection. Keep the response natural and short.`;
  }
  const temperature = brainConfig.temperature || 0.7;
  const maxTokens = brainConfig.maxTokens || 1024;
  const userPrompt = buildUserPrompt(message, username, history);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: userPrompt },
  ];
  try {
    log.info(`🤖 Sending through AI provider router (brain: ${brainName})`);
    const start = Date.now();
    const reply = await ai.chat(messages, { temperature, maxTokens });
    const latency = Date.now() - start;
    promMetrics.aiLatency.observe(latency / 1000);
    promMetrics.aiCalls.inc();
    promMetrics.tokenUsage.inc(Math.ceil((userPrompt.length + systemPrompt.length) / 4));
    const processedReply = await Brain.processResponse(reply, { channel, user, message });
    if (brainName === 'moderation') {
      if (processedReply.toxic) {
        log.warn(`Toxicity detected from ${username}: ${processedReply.reason}`);
        enqueueTask('moderation-review', { channel, user: username, message, reason: processedReply.reason });
      }
      return;
    }
    let finalReply = processedReply || reply;
    if (!finalReply.trim()) finalReply = getFallbackResponse();
    if (offerFollow) finalReply = `${finalReply} ${followLineFor(login)}`;
    if (offerSubscription) finalReply = `${finalReply} ${subscriptionLineFor()}`;
    if (salesSelection.eligible) finalReply = `${finalReply} ${salesSelection.text}`;
    if (proactiveWelcome) promMetrics.viewerWelcomes.inc();
    if (brainName === 'analyst') promMetrics.analyticalReplies.inc();
    if (analyticalAutoComment) {
      promMetrics.analyticalAutoComments.inc();
      engagementAttribution.recordAnalytical(channel, Date.now());
    }
    if (offerFollow) promMetrics.followPrompts.inc();
    if (offerSubscription) promMetrics.subscriptionPrompts.inc();
    if (salesSelection.eligible) {
      await commerceEngine.recordImpression({ channel, viewer: login, selection: salesSelection });
      promMetrics.commerceImpressions.inc({ offer: salesSelection.offer.id });
      promMetrics.commerceBanditScore.observe(salesSelection.banditScore);
    }
    const sentAt = Date.now();
    if (retentionSelection.eligible) {
      await retentionEngine.recordImpression({ channel, viewer: login, selection: retentionSelection, at: sentAt });
      promMetrics.retentionPrompts.inc({ strategy: retentionSelection.strategy });
      promMetrics.retentionBanditScore.observe(retentionSelection.banditScore);
    }
    await ConversationStore.pushMessage(channel, 'assistant', finalReply);
    await ProfileStore.update(channel, login, {
      botInteractions: viewerProfile.botInteractions + 1,
      followPromptedAt: offerFollow ? sentAt : viewerProfile.followPromptedAt,
      subscriptionPromptedAt: offerSubscription ? sentAt : viewerProfile.subscriptionPromptedAt,
      lastCommercialPromptAt: salesSelection.eligible ? sentAt : viewerProfile.lastCommercialPromptAt,
      commercialPromptCount: Number(viewerProfile.commercialPromptCount || 0) + (salesSelection.eligible ? 1 : 0),
      lastBotReplyAt: sentAt,
      lastRetentionPromptAt: retentionSelection.eligible ? sentAt : viewerProfile.lastRetentionPromptAt,
      lastRetentionStrategy: retentionSelection.eligible ? retentionSelection.strategy : viewerProfile.lastRetentionStrategy,
      retentionPromptCount: Number(viewerProfile.retentionPromptCount || 0) + (retentionSelection.eligible ? 1 : 0),
    });
    if (config.emotes.enable) {
      const emote = getRandomEmote(channel);
      if (emote) finalReply += ` ${emote}`;
    }
    if (messageQueue) messageQueue.enqueue(channel, finalReply, { priority: (directInteraction || analyticalAutoComment) ? 'high' : 'normal' });
    else await global.twitchClient.say(channel, finalReply);
    promMetrics.messagesSent.inc();
  } catch (err) {
    const status = Number(err?.status || err?.response?.status || 0) || null;
    const code = String(err?.code || '');
    if (status === 402 || code === 'insufficient_balance') {
      log.warn('AI provider balance unavailable; using local conversational fallback');
    } else {
      log.error('AI chat error', err);
    }
    promMetrics.aiErrors.inc();
    const fallback = retentionSelection?.eligible
      ? retentionEngine.localFallback({
          username,
          message,
          strategy: retentionSelection.strategy,
          questionAllowed: retentionSelection.questionAllowed,
          language: responseLanguage,
        })
      : ((status === 402 || code === 'insufficient_balance')
          ? localizedGenericFallback({ code: responseLanguage, username })
          : getFallbackResponse());

    const sentAt = Date.now();
    if (retentionSelection?.eligible) {
      await retentionEngine.recordImpression({ channel, viewer: login, selection: retentionSelection, at: sentAt });
      promMetrics.retentionPrompts.inc({ strategy: retentionSelection.strategy });
      promMetrics.retentionBanditScore.observe(retentionSelection.banditScore);
      await ProfileStore.update(channel, login, {
        botInteractions: viewerProfile.botInteractions + 1,
        lastBotReplyAt: sentAt,
        lastRetentionPromptAt: sentAt,
        lastRetentionStrategy: retentionSelection.strategy,
        retentionPromptCount: Number(viewerProfile.retentionPromptCount || 0) + 1,
      });
      await ConversationStore.pushMessage(channel, 'assistant', fallback);
    } else {
      await ProfileStore.update(channel, login, {
        botInteractions: viewerProfile.botInteractions + 1,
        lastBotReplyAt: sentAt,
      });
    }
    if (messageQueue) messageQueue.enqueue(channel, fallback, { priority: directInteraction ? 'high' : 'normal' });
    else await global.twitchClient.say(channel, fallback);
    promMetrics.messagesSent.inc();
  }
}

// Follow/new-viewer engagement is driven by chat activity, never JOIN/lurker presence.
async function handleUserNotice({ channel, user, msg, tags }) {
  const msgId = tags?.['msg-id'];
  if (msgId === 'raid') {
    const from = tags['display-name'] || 'someone';
    const reply = `Thanks for the raid, ${from}! PogChamp`;
    if (messageQueue) messageQueue.enqueue(channel, reply);
    else await global.twitchClient.say(channel, reply);
    return;
  }

  const subscriptionNotices = new Set(['sub', 'resub', 'subgift', 'anonsubgift', 'submysterygift', 'anonsubmysterygift']);
  if (subscriptionNotices.has(msgId)) {
    const subName = tags?.['display-name'] || user?.username || user || 'a viewer';
    const viewerLogin = String(tags?.login || user?.username || tags?.['display-name'] || '').toLowerCase();
    if (viewerLogin) {
      recordNativeCommerceConversion({
        broadcaster_user_login: String(channel || '').replace(/^#/, ''),
        user_login: viewerLogin,
      }, 'twitch_sub', `irc_${msgId}`).catch(err => log.warn('Subscription conversion tracking failed', err.message));
    }
    const reply = `Thanks for the sub, ${subName}! Much love <3`;
    if (messageQueue) messageQueue.enqueue(channel, reply);
    else await global.twitchClient.say(channel, reply);
  }
}

async function recordNativeCommerceConversion(event, expectedOfferId, source) {
  const channel = `#${String(event?.broadcaster_user_login || config.twitch.channels[0] || '').replace(/^#/, '').toLowerCase()}`;
  const viewer = String(event?.user_login || '').toLowerCase();
  if (!viewer) {
    promMetrics.commerceConversions.inc({ offer: expectedOfferId, source, attributed: 'false' });
    return;
  }
  const result = await commerceEngine.recordConversion({ channel, viewer, expectedOfferId });
  promMetrics.commerceConversions.inc({ offer: expectedOfferId, source, attributed: String(Boolean(result.attributed)) });
  if (result.attributed) {
    await ProfileStore.update(channel, viewer, { lastCommercialConversionAt: Date.now() });
  }
}

async function handleClearChat({ channel }) {
  log.info(`Chat cleared in ${channel}`);
}

app.get('/', (req, res) => {
  res.send(`<h1>SweatyClanker Bot</h1><p>Status: Running</p><p>Chat identity required: <strong>${configuredBotLogin()}</strong></p><p><a href="/auth/login">Authorize SweatyClanker bot account</a></p>`);
});

// ========== INITIALIZATION ==========
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
  log.info('Initializing AI provider failover...');
  ai = createAIClient();
  log.info('AI provider router ready', ai.getHealth());
  highlightDetector = new HighlightDetector(ai);
  await highlightDetector.start();
  log.info('Initializing moderation...');
  moderation = new Moderation(config.moderation);
  log.info('Loading custom commands...');
  await loadCustomCommandsIntoMemory();
  if (process.env.WORKERS_ENABLED === 'true') {
    const queueNames = enabledWorkerQueues(Object.keys(jobHandlers));
    if (!getRedis()) {
      log.warn('BullMQ workers skipped because Redis is unavailable; core chat stays online');
    } else if (!queueNames.length) {
      log.info('No BullMQ workers are needed for the currently enabled delivery features');
    } else {
      log.info('Starting demand-driven BullMQ workers...');
      for (const q of queueNames) {
        const worker = startWorker(q, jobHandlers[q], 1);
        if (worker) workers.push(worker);
      }
      const budget = workerRedisBudget();
      const estimatedPolls = estimatedMonthlyIdlePolls(queueNames.length, budget);
      log.info(`Task workers started for: ${queueNames.join(', ')} (estimated idle polls/month ≈ ${estimatedPolls})`);
    }
  } else {
    log.info('BullMQ workers disabled');
  }

  // Register bus listeners before plugins
  bus.on('twitch.message', async (...args) => {
    log.info('🔊 BUS: twitch.message event received');
    try { await handleMessage(...args); } catch (err) { log.error('Error in handleMessage', err); }
  });
  bus.on('twitch.join', ({ channel, username, self }) => {
    try {
      if (!shouldWelcomeJoin({
        channel,
        username,
        self,
        botLogin: configuredBotLogin(),
        ignoredUsers: config.twitch.ignoredUsers,
      })) return;

      const login = String(username).toLowerCase();
      lurkerActivationEngine.onJoin({ channel, username: login });

      if (config.auto.welcomeOnJoin) {
        joinWelcomeBatcher.add(channel, login);
      }
    } catch (err) {
      log.warn('Failed to process Twitch join', err.message);
    }
  });
  bus.on('twitch.part', ({ channel, username, self }) => {
    if (self) return;
    lurkerActivationEngine.onPart({ channel, username });
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
  bus.on('eventsub.channel.follow', async (event) => {
    try {
      const channel = `#${String(event?.broadcaster_user_login || '').toLowerCase()}`;
      const viewer = String(event?.user_login || '').toLowerCase();
      if (channel !== '#' && viewer) {
        promMetrics.followEvents.inc();
        await ProfileStore.update(channel, viewer, { followed: true, followedAt: Date.now() });
      }
    } catch (err) {
      log.warn('Failed to record follower state', err.message);
    }
  });
  bus.on('twitch.connected', () => {
    if (!messageQueue && global.twitchClient) {
      messageQueue = new MessageQueue(global.twitchClient);
      log.info('Message queue initialized on Twitch connect');
    }
  });
  bus.on('twitch.ready', () => {
    log.info('Twitch client is ready. Starting auto-messages...');
    startAutoMessages();
  });

  // Load plugins only after the ready listener exists. The Twitch plugin emits
  // twitch.ready during registration, so registering this afterward misses it.
  log.info('Loading plugins...');
  await loadPlugins(bus, config);

  const twitchClient = global.twitchClient;
  if (twitchClient && !messageQueue) {
    log.info('Initializing message queue...');
    messageQueue = new MessageQueue(twitchClient);
    log.info('Message queue initialized');
  }

  try {
    log.info('Connecting to EventSub...');
    eventSubClient = new EventSubClient();
    await eventSubClient.connect();
    log.info('EventSub client connected');
  } catch (err) {
    log.warn('EventSub unavailable. Continuing without EventSub.', err.message);
  }

  log.info('Bot initialization complete');
  broadcast({ type: 'ready' });
}

// ========== BOOTSTRAP ==========
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
    log.info(`🌐 Server running on port ${port}`);
  });
}

// ========== SHUTDOWN ==========
async function shutdown() {
  log.info('Shutting down gracefully...');
  if (global._autoMessageTimer) clearInterval(global._autoMessageTimer);
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  if (messageQueue) messageQueue.stop();
  joinWelcomeBatcher.stop();
  lurkerActivationEngine.stop();
  if (highlightDetector) highlightDetector.stop();
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
