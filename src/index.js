import express from 'express';
import expressWs from 'express-ws';
import fs from 'fs';
import { job } from './utils/keep_alive.js';
import AIOperations from './ai/operations.js';
import { TwitchBot } from './twitch/twitch_bot.js';
import EmoteHandler from './twitch/emote_handler.js';
import MediaProcessor from './media/media_processor.js';
import UrlHandler from './media/url_handler.js';
import ErrorHandler from './utils/error_handler.js';
import SystemInstructionBuilder from './ai/system_instruction_builder.js';
import { getHelixIds } from './twitch/apiClient.js';
import { PollinationsClient } from './media/media_providers.js';
import { Storage } from './utils/storage.js';
import {
    initTokenManager,
    loadTokens,
    exchangeCodeForTokens,
    isAuthorized
} from './twitch/tokenManager.js';
import {
    fetchSevenTvChannelEmotesForTwitchIds,
    fetchSevenTvGlobalEmotes,
    fetchBttvChannelEmotesForTwitchIds,
    fetchBttvGlobalEmotes,
    fetchFfzChannelEmotesForTwitchIds,
    fetchFfzGlobalEmotes
} from './twitch/emote_providers.js';
import { getSystemPrompt, shouldRespond, getFallbackResponse } from './personality.js';

// =====================================================================================
// STRUCTURED LOGGING
// -------------------------------------------------------------------------------------
// Every log line carries a tag + timestamp so logs stay greppable in production.
// Never log secrets (tokens, API keys) — see log() call sites for redaction discipline.
// =====================================================================================
const TAGS = ['BOOT', 'IRC', 'TWITCH', 'CHAT', 'AI', 'COMMAND', 'MEMORY', 'REDIS', 'HTTP', 'ERROR', 'RECOVERY'];
function log(tag, ...args) {
    const ts = new Date().toISOString();
    const prefix = `[${tag}] [${ts}]`;
    if (tag === 'ERROR') {
        console.error(prefix, ...args);
    } else {
        console.log(prefix, ...args);
    }
}

// =====================================================================================
// CONFIGURATION
// =====================================================================================
job.start();

const storage = new Storage();
initTokenManager(storage);

const app = express();
const wsInstance = expressWs(app);
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;

const broadcastWs = (data) => {
    wsInstance.getWss().clients.forEach((client) => {
        if (client.readyState === 1) {
            client.send(JSON.stringify(data));
        }
    });
};

async function addMediaEntry(entry) {
    await storage.addMediaEntry(entry);
    broadcastWs({ type: 'media', entry });
}

app.head('/healthz', (_req, res) => {
    res.status(204).end();
});

app.get('/healthz', (_req, res) => {
    res.type('text/plain').set('Cache-Control', 'no-store').send('OK');
});

app.set('view engine', 'ejs');

// --- AI / DeepSeek configuration ---------------------------------------------------
// DEEPSEEK_* is the canonical env var name. GEMINI_* is accepted as a legacy fallback
// so existing Render deployments don't break on upgrade, but a warning is logged.
function envWithLegacyFallback(canonicalName, legacyName, fallback) {
    if (process.env[canonicalName] !== undefined) return process.env[canonicalName];
    if (process.env[legacyName] !== undefined) {
        log('BOOT', `WARNING: ${legacyName} is deprecated, please rename to ${canonicalName}.`);
        return process.env[legacyName];
    }
    return fallback;
}

const AI_HISTORY_LENGTH = process.env.AI_HISTORY_LENGTH || 5;
const DEEPSEEK_API_KEY = envWithLegacyFallback('DEEPSEEK_API_KEY', 'GEMINI_API_KEY', '');
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
const MODEL_NAME = envWithLegacyFallback('DEEPSEEK_MODEL_NAME', 'MODEL_NAME', 'deepseek-chat');
const IMAGE_COMMAND_NAME = process.env.IMAGE_COMMAND_NAME || '!image';
const VIDEO_COMMAND_NAME = process.env.VIDEO_COMMAND_NAME || '!video';
const TTS_COMMAND_NAME = process.env.TTS_COMMAND_NAME || '!tts';
const MUSIC_COMMAND_NAME = process.env.MUSIC_COMMAND_NAME || '!song';
const TWITCH_USERNAME = process.env.TWITCH_USERNAME || '';
const BOT_COMMAND_NAME = process.env.BOT_COMMAND_NAME || '!clanker';
const BOT_PERSONA_NAMES = (process.env.BOT_PERSONA_NAMES || 'sweaty clanker,sweatyclanker,clanker')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const JOIN_CHANNELS = process.env.JOIN_CHANNELS || '';
const COOLDOWN_DURATION = process.env.COOLDOWN_DURATION !== undefined ? parseInt(process.env.COOLDOWN_DURATION, 10) : 1;
const USER_COOLDOWN_DURATION = process.env.USER_COOLDOWN_DURATION !== undefined ? parseInt(process.env.USER_COOLDOWN_DURATION, 10) : 5;
const ENABLE_SEARCH_GROUNDING = 'false'; // Not supported by DeepSeek; kept for AIOperations signature compatibility
const IGNORED_USERNAMES = process.env.IGNORED_USERNAMES || '';
const ignoredUsernames = IGNORED_USERNAMES.split(',').map(user => user.trim().toLowerCase()).filter(Boolean);
const ENABLE_EMOTE_APPENDING = process.env.ENABLE_EMOTE_APPENDING || 'true';
const EMOTE_APPEND_EXCLUDE_PREFIXES = process.env.EMOTE_APPEND_EXCLUDE_PREFIXES || '';

const ENABLE_7TV_EMOTES = process.env.ENABLE_7TV_EMOTES || 'true';
const ENABLE_BTTV_EMOTES = process.env.ENABLE_BTTV_EMOTES || 'true';
const ENABLE_FFZ_EMOTES = process.env.ENABLE_FFZ_EMOTES || 'false';

const INCLUDE_7TV_GLOBAL_EMOTES = process.env.INCLUDE_7TV_GLOBAL_EMOTES || 'false';
const INCLUDE_BTTV_GLOBAL_EMOTES = process.env.INCLUDE_BTTV_GLOBAL_EMOTES || 'false';
const INCLUDE_FFZ_GLOBAL_EMOTES = process.env.INCLUDE_FFZ_GLOBAL_EMOTES || 'false';

const EMOTE_FETCH_TIMEOUT_MS = process.env.EMOTE_FETCH_TIMEOUT_MS !== undefined
    ? parseInt(process.env.EMOTE_FETCH_TIMEOUT_MS, 10)
    : 10000;

const commandNames = BOT_COMMAND_NAME.split(',').map(cmd => cmd.trim().toLowerCase());
const imageCommandNames = IMAGE_COMMAND_NAME.split(',').map(cmd => cmd.trim().toLowerCase());
const videoCommandNames = VIDEO_COMMAND_NAME.split(',').map(cmd => cmd.trim().toLowerCase());
const ttsCommandNames = TTS_COMMAND_NAME.split(',').map(cmd => cmd.trim().toLowerCase());
const musicCommandNames = MUSIC_COMMAND_NAME.split(',').map(cmd => cmd.trim().toLowerCase());
const channels = JOIN_CHANNELS.split(',').map(channel => channel.trim()).filter(Boolean);
const maxLength = 499;

const fileContext = getSystemPrompt();

// =====================================================================================
// COOLDOWNS
// -------------------------------------------------------------------------------------
// A single shared `lastResponseTime` let one active chatter lock out everyone else.
// We now track cooldowns per (channel + user) for chat/AI triggers, and a separate,
// coarser per-channel cooldown for expensive media generation calls.
// =====================================================================================
const userCooldowns = new Map(); // key: `${channel}:${username}` -> timestamp
const mediaCooldowns = new Map(); // key: channel -> timestamp

function isOnCooldown(map, key, durationSeconds) {
    if (durationSeconds <= 0) return { onCooldown: false, remaining: 0 };
    const last = map.get(key) || 0;
    const elapsed = (Date.now() - last) / 1000;
    if (elapsed < durationSeconds) {
        return { onCooldown: true, remaining: (durationSeconds - elapsed).toFixed(1) };
    }
    return { onCooldown: false, remaining: 0 };
}

function markCooldown(map, key) {
    map.set(key, Date.now());
}

// =====================================================================================
// CUSTOM COMMANDS
// -------------------------------------------------------------------------------------
// Prefers Redis-backed commands (storage.getCustomCommands) when available so commands
// can be managed live without a redeploy. Falls back to custom_commands.txt otherwise.
// =====================================================================================
function loadCustomCommandsFromFile() {
    const commands = new Map();
    try {
        const data = fs.readFileSync('./custom_commands.txt', 'utf8');
        const lines = data.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eqIndex = trimmed.indexOf('=');
            if (eqIndex === -1) continue;
            const left = trimmed.substring(0, eqIndex).trim();
            const response = trimmed.substring(eqIndex + 1).trim();

            let cmd;
            let role;
            const pipeIndex = left.indexOf('|');
            if (pipeIndex !== -1) {
                cmd = left.substring(0, pipeIndex).trim().toLowerCase();
                role = left.substring(pipeIndex + 1).trim().toLowerCase();
            } else {
                cmd = left.toLowerCase();
                role = 'all';
            }

            if (!['broadcaster', 'moderator', 'all'].includes(role)) {
                log('COMMAND', `Invalid role "${role}" for command "${cmd}", defaulting to "all"`);
                role = 'all';
            }

            if (cmd && response) {
                commands.set(cmd, { response, role });
            }
        }
        log('COMMAND', `Loaded ${commands.size} command(s) from custom_commands.txt`);
    } catch (error) {
        if (error.code === 'ENOENT') {
            log('COMMAND', 'No custom_commands.txt found, skipping.');
        } else {
            log('ERROR', 'Failed loading custom_commands.txt:', error);
        }
    }
    return commands;
}

let customCommands = new Map();

async function loadCustomCommands() {
    if (storage.configured && typeof storage.getCustomCommands === 'function') {
        try {
            const stored = await storage.getCustomCommands();
            if (stored && stored.size > 0) {
                log('COMMAND', `Loaded ${stored.size} command(s) from Redis`);
                return stored;
            }
        } catch (error) {
            log('ERROR', 'Failed loading custom commands from Redis, falling back to file:', error.message);
        }
    }
    return loadCustomCommandsFromFile();
}

function userHasCustomCommandRole(user, requiredRole) {
    if (!requiredRole || requiredRole === 'all') return true;

    const isBroadcaster = user && user.badges && user.badges.broadcaster;
    const isMod = (user && user.mod) || (user && user.badges && user.badges.moderator);

    switch (requiredRole) {
        case 'broadcaster':
            return !!isBroadcaster;
        case 'moderator':
            return !!isBroadcaster || !!isMod;
        default:
            return true;
    }
}

const excludedPrefixes = EMOTE_APPEND_EXCLUDE_PREFIXES.split(',')
    .map(prefix => prefix.trim().toLowerCase())
    .filter(prefix => prefix.length > 0);

const channelEmotesForFiltering = new Map();
const channelEmotesForAppending = new Map();
const channelEmotePools = new Map();
const channelEmoteHandlers = new Map();

const EMOTE_PLATFORMS = ['7tv', 'bttv', 'ffz'];

const cleanEmoteList = (list) =>
    [...new Set((list || [])
        .filter(e => typeof e === 'string')
        .map(e => e.trim())
        .filter(Boolean)
    )].sort((a, b) => a.localeCompare(b));

function normalizeEmoteData(raw) {
    const out = Object.fromEntries(EMOTE_PLATFORMS.map(k => [k, []]));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const k of EMOTE_PLATFORMS) out[k] = cleanEmoteList(raw[k]);
    return out;
}

function rebuildEmotePoolForChannel(channelKey) {
    const appending = channelEmotesForAppending.get(channelKey);
    const pool = new Set();
    for (const k of EMOTE_PLATFORMS) {
        for (const e of (appending?.[k] || [])) pool.add(e);
    }
    channelEmotePools.set(channelKey, [...pool]);
    log('CHAT', `Random append pool rebuilt for ${channelKey}: ${channelEmotePools.get(channelKey).length} emotes`);
}

function normalizeChannelKey(channel) {
    const clean = channel.replace('#', '').toLowerCase();
    return `#${clean}`;
}

const fallbackEmoteHandler = new EmoteHandler();

function getEmoteHandler(channel) {
    if (!channel) return fallbackEmoteHandler;
    return channelEmoteHandlers.get(normalizeChannelKey(channel)) || fallbackEmoteHandler;
}

function shouldExcludeEmoteAppending(response) {
    if (excludedPrefixes.length === 0) return false;
    const lowerResponse = response.toLowerCase();
    return excludedPrefixes.some(prefix => lowerResponse.startsWith(prefix));
}

function getRandomEmote(channel) {
    if (ENABLE_EMOTE_APPENDING !== 'true') return '';
    try {
        const key = channel ? normalizeChannelKey(channel) : null;
        const pool = key ? channelEmotePools.get(key) : null;
        if (!pool || pool.length === 0) return '';
        return pool[Math.floor(Math.random() * pool.length)];
    } catch (error) {
        log('ERROR', 'Error selecting a random emote:', error);
        return '';
    }
}

const mediaInstructionsTemplate = `ATTENTION: this is NOT a request to generate {media_type} — the {media_type} was already generated by the system.
User: {username}
User's original description: "{description}"
The {media_type} is available at this URL: {media_url}

DO NOT tell the user to use {command}.
You MUST include the exact URL {media_url} verbatim in your response. Do not alter, truncate, or omit it.
Always place the URL with spaces around it if mid-sentence, flowing directly into the punchline's first word without punctuation or backticks touching it.
Speak in first person, as if you're presenting your {media_type} to the user. Keep it shorter than usual (<=30 words), smoothly integrating the URL.
Avoid phrases like "I made this for you", rather focus on the description and subject matter of the {media_type} itself.
Vary your openers — you might hint at the process, drop a reaction, or throw shade before revealing the link.
End with a one-line punchline riffing on one detail from the user's description, ensuring each sign-off feels unique.
Double-check: The URL {media_url} must appear exactly as-is in your response, with no punctuation or backticks touching it.`;

function getMediaInstruction(username, description, mediaUrl, mediaType, command) {
    const sanitizedDescription = (description || '').replace(/https?:\/\/\S+/g, '[original-url]').replace(/\s+/g, ' ').trim();
    return mediaInstructionsTemplate
        .replace(/\{media_type\}/g, mediaType)
        .replace(/\{username\}/g, username)
        .replace(/\{media_url\}/g, mediaUrl)
        .replace(/\{description\}/g, sanitizedDescription)
        .replace(/\{command\}/g, command);
}

let bot = null;
let aiOps = null;
let botId = null;
let channelIdMap = {};
let twitchRuntimeStarted = false;
let twitchRuntimePromise = null;

const mediaProcessor = new MediaProcessor();
const urlHandler = new UrlHandler();
const errorHandler = new ErrorHandler();
const systemInstructionBuilder = new SystemInstructionBuilder(urlHandler);
const pollinationsClient = new PollinationsClient();

// =====================================================================================
// STARTUP VALIDATION
// -------------------------------------------------------------------------------------
// Runs before Twitch connects. Prints a clear summary and never silently swallows a
// misconfiguration — every check either passes, fails loudly, or is explicitly skipped.
// =====================================================================================
async function validateStartup() {
    const results = [];

    const requiredEnv = ['TWITCH_USERNAME', 'TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'JOIN_CHANNELS'];
    const missingEnv = requiredEnv.filter(name => !process.env[name]);
    results.push({ label: 'Environment variables', ok: missingEnv.length === 0, detail: missingEnv.length ? `Missing: ${missingEnv.join(', ')}` : null });

    results.push({ label: 'DeepSeek API key', ok: !!DEEPSEEK_API_KEY, detail: DEEPSEEK_API_KEY ? null : 'DEEPSEEK_API_KEY is not set' });

    results.push({ label: 'Redis (storage)', ok: storage.configured, detail: storage.configured ? null : 'Running in memory-only mode; state will not survive restarts' });

    results.push({ label: 'Twitch OAuth', ok: isAuthorized(), detail: isAuthorized() ? null : 'Not authorized yet — visit /auth/login' });

    if (!YOUTUBE_API_KEY) {
        results.push({ label: 'YouTube metadata', ok: false, detail: 'YOUTUBE_API_KEY not set — YouTube link context disabled (non-fatal)' });
    } else {
        results.push({ label: 'YouTube metadata', ok: true, detail: null });
    }

    log('BOOT', '===== Startup Summary =====');
    for (const r of results) {
        const icon = r.ok ? '✔' : '✘';
        log('BOOT', `${icon} ${r.label}${r.detail ? ` — ${r.detail}` : ''}`);
    }
    log('BOOT', '============================');

    return results;
}

async function initializeEmotes() {
    const twitchIds = [...new Set(Object.values(channelIdMap || {}).filter(Boolean))];
    const timeoutOpts = { timeoutMs: EMOTE_FETCH_TIMEOUT_MS };

    const providers = [
        { key: '7tv', name: '7TV', enabled: ENABLE_7TV_EMOTES === 'true', includeGlobals: INCLUDE_7TV_GLOBAL_EMOTES === 'true', fetchChannel: fetchSevenTvChannelEmotesForTwitchIds, fetchGlobal: fetchSevenTvGlobalEmotes },
        { key: 'bttv', name: 'BTTV', enabled: ENABLE_BTTV_EMOTES === 'true', includeGlobals: INCLUDE_BTTV_GLOBAL_EMOTES === 'true', fetchChannel: fetchBttvChannelEmotesForTwitchIds, fetchGlobal: fetchBttvGlobalEmotes },
        { key: 'ffz', name: 'FFZ', enabled: ENABLE_FFZ_EMOTES === 'true', includeGlobals: INCLUDE_FFZ_GLOBAL_EMOTES === 'true', fetchChannel: fetchFfzChannelEmotesForTwitchIds, fetchGlobal: fetchFfzGlobalEmotes }
    ];

    const globalEmotes = Object.fromEntries(EMOTE_PLATFORMS.map(k => [k, []]));
    const channelEmotesByProvider = Object.fromEntries(EMOTE_PLATFORMS.map(k => [k, new Map()]));

    for (const p of providers) {
        if (!p.enabled) {
            log('CHAT', `${p.name} emotes disabled.`);
            continue;
        }
        try {
            const perIdMap = (await p.fetchChannel(twitchIds, timeoutOpts)) || new Map();
            channelEmotesByProvider[p.key] = perIdMap;
            if (p.includeGlobals) {
                globalEmotes[p.key] = (await p.fetchGlobal(timeoutOpts)) || [];
            }
            const totalChannel = [...perIdMap.values()].reduce((s, a) => s + a.length, 0);
            log('CHAT', `${p.name} loaded: channel=${totalChannel} (across ${perIdMap.size} channels), global=${globalEmotes[p.key].length}`);
        } catch (error) {
            log('ERROR', `${p.name} emote fetch failed:`, error.message || error);
        }
    }

    for (const ch of channels) {
        const cleanName = ch.replace('#', '').toLowerCase();
        const twitchId = channelIdMap[cleanName];
        const channelKey = `#${cleanName}`;

        const filtering = Object.fromEntries(EMOTE_PLATFORMS.map(k => [k, []]));
        const appending = Object.fromEntries(EMOTE_PLATFORMS.map(k => [k, []]));

        for (const k of EMOTE_PLATFORMS) {
            const channelSpecific = (twitchId && channelEmotesByProvider[k]?.get(twitchId)) || [];
            const global = globalEmotes[k] || [];
            const combined = cleanEmoteList([...channelSpecific, ...global]);
            filtering[k] = combined;
            appending[k] = combined;
        }

        const normalizedFiltering = normalizeEmoteData(filtering);
        const normalizedAppending = normalizeEmoteData(appending);

        channelEmotesForFiltering.set(channelKey, normalizedFiltering);
        channelEmotesForAppending.set(channelKey, normalizedAppending);

        const handler = new EmoteHandler();
        handler.setEmoteData(normalizedFiltering);
        channelEmoteHandlers.set(channelKey, handler);

        rebuildEmotePoolForChannel(channelKey);

        const total = Object.values(normalizedFiltering).reduce((sum, arr) => sum + arr.length, 0);
        log('CHAT', `${channelKey}: ${total} emotes loaded`);
    }
}

function getRequestOrigin(req) {
    return `${req.protocol}://${req.get('host')}`;
}

function getTwitchRedirectUri(req) {
    return `${getRequestOrigin(req)}/auth/callback`;
}

function buildTwitchAuthUrl(req) {
    if (!process.env.TWITCH_CLIENT_ID) {
        throw new Error('TWITCH_CLIENT_ID is required.');
    }

    const scopes = [
        'chat:read',
        'chat:edit',
        'user:bot',
        'user:read:chat',
        'user:write:chat'
    ];

    const url = new URL('https://id.twitch.tv/oauth2/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', process.env.TWITCH_CLIENT_ID);
    url.searchParams.set('redirect_uri', getTwitchRedirectUri(req));
    url.searchParams.set('scope', scopes.join(' '));
    return url.toString();
}

async function resolveTwitchIds() {
    if (!TWITCH_USERNAME) {
        throw new Error('TWITCH_USERNAME environment variable is required.');
    }

    const allUsernames = [TWITCH_USERNAME, ...channels];
    const uniqueUsernames = [...new Set(allUsernames.map(u => u.replace('#', '').toLowerCase()).filter(Boolean))];

    log('TWITCH', `Resolving IDs for ${uniqueUsernames.length} users...`);
    const idMap = await getHelixIds(uniqueUsernames);

    const resolvedBotId = idMap[TWITCH_USERNAME.toLowerCase()];
    if (!resolvedBotId) {
        throw new Error(`Could not resolve ID for bot user: ${TWITCH_USERNAME}`);
    }

    const resolvedChannelIdMap = {};
    for (const channel of channels) {
        const cleanName = channel.replace('#', '').toLowerCase();
        if (idMap[cleanName]) {
            resolvedChannelIdMap[cleanName] = idMap[cleanName];
        } else {
            log('ERROR', `Could not resolve ID for channel: ${channel}`);
        }
    }

    botId = resolvedBotId;
    channelIdMap = resolvedChannelIdMap;
    log('TWITCH', `Channel ID Map resolved: ${Object.keys(channelIdMap).length} channels ready.`);
}

// Sends a (possibly long) message, splitting on maxLength boundaries. Chunks are sent
// sequentially (awaited) rather than via parallel setTimeout, so ordering and rate-limit
// backoff (handled inside TwitchBot.say) are respected.
async function sendChatResponse(channel, text) {
    if (text.length <= maxLength) {
        await bot.say(channel, text);
        return;
    }
    const messages = text.match(new RegExp(`.{1,${maxLength}}`, 'g')) || [];
    for (const msg of messages) {
        await bot.say(channel, msg);
    }
}

async function executeMediaPipeline({ channel, user, message, command, service, mediaType, providerCall }) {
    if (!bot || !aiOps) {
        log('ERROR', 'Media pipeline invoked before bot runtime was ready.');
        return;
    }

    const username = (user && (user['display-name'] || user.username || user.name)) || 'someone';
    const prompt = message.slice(command.length).replace(/^,\s*/, '').trim();

    if (!prompt) {
        await bot.say(channel, errorHandler.getMessage('MEDIA_PROMPT_REQUIRED', { username, mediaType }));
        return;
    }

    const cooldownCheck = isOnCooldown(mediaCooldowns, channel, COOLDOWN_DURATION);
    if (cooldownCheck.onCooldown) {
        await bot.say(channel, errorHandler.getMessage('COOLDOWN_ACTIVE', { remainingTime: cooldownCheck.remaining }));
        return;
    }
    markCooldown(mediaCooldowns, channel);

    try {
        const result = await providerCall(prompt);
        let finalMediaUrl;

        if (result.buffer) {
            log('CHAT', `Uploading ${service} ${mediaType} to storage (${result.buffer.length} bytes)...`);
            if (mediaType === 'image') {
                finalMediaUrl = await mediaProcessor.uploadImage(result.buffer, result.mimeType || 'image/png');
            } else if (mediaType === 'video') {
                finalMediaUrl = await mediaProcessor.uploadVideo(result.buffer, result.mimeType || 'video/mp4');
            } else {
                finalMediaUrl = await mediaProcessor.uploadAudio(result.buffer, result.mimeType || 'audio/mpeg');
            }
            log('CHAT', `${service} ${mediaType} uploaded: ${finalMediaUrl}`);
        } else {
            await bot.say(channel, errorHandler.getMessage('MEDIA_NO_DATA', { service, mediaType }));
            return;
        }

        await addMediaEntry({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: Date.now(),
            channel,
            username,
            command,
            prompt,
            mediaUrl: finalMediaUrl,
            mediaType
        });

        const displayType = mediaType === 'tts' ? 'TTS audio' : mediaType;
        const ephemeralContext = getMediaInstruction(username, prompt, finalMediaUrl, displayType, command);

        const userPrompt = `User requested: ${prompt}`;
        const rawResponse = await aiOps.generateResponse(userPrompt, {
            disableMultimedia: true,
            channel,
            ephemeralContext,
            emoteHandler: getEmoteHandler(channel)
        });

        let finalResponse = rawResponse || '';
        if (!finalResponse.includes(finalMediaUrl)) {
            finalResponse = finalResponse.trim().length > 0
                ? `${finalResponse.trim()} ${finalMediaUrl}`
                : `${finalMediaUrl}`;
        }
        if (!finalResponse.trim()) {
            finalResponse = errorHandler.getMessage('MEDIA_FALLBACK_RESPONSE', { mediaType, username, url: finalMediaUrl });
        }

        let responseWithEmote = finalResponse;
        if (ENABLE_EMOTE_APPENDING === 'true' && !shouldExcludeEmoteAppending(finalResponse)) {
            const emote = getRandomEmote(channel);
            responseWithEmote = emote ? `${finalResponse} ${emote}` : finalResponse;
        }

        await sendChatResponse(channel, responseWithEmote);
    } catch (error) {
        const reason = errorHandler.createErrorResponse(error);
        log('ERROR', `${service} ${mediaType} generation failed: ${reason}`, error);
        await bot.say(channel, getFallbackResponse());
    }
}

async function initializeTwitchRuntime() {
    if (!isAuthorized()) {
        log('TWITCH', 'Authorization required. Bot runtime is waiting.');
        return false;
    }

    if (twitchRuntimeStarted) return true;
    if (twitchRuntimePromise) return twitchRuntimePromise;

    twitchRuntimePromise = (async () => {
        await resolveTwitchIds();

        const twitchBot = new TwitchBot(TWITCH_USERNAME, channels, botId, channelIdMap);

        twitchBot.onLogEntry = (channel, entry) => {
            broadcastWs({ type: 'chat', channel, entry });
            storage.addChatMessage(channel, entry).catch(err => {
                log('ERROR', 'Failed to save chat to storage:', err.message);
            });
        };

        twitchBot.onMessage(async (channel, user, message, self) => {
            if (self || (user && user.username && user.username.toLowerCase() === TWITCH_USERNAME.toLowerCase())) {
                return;
            }

            const username = (user && (user['display-name'] || user.username || user.name)) || '';
            const loginName = (user && user.username) ? user.username.toLowerCase() : '';
            if (ignoredUsernames.includes(loginName)) {
                return;
            }

            const handler = getEmoteHandler(channel);
            const messageForLogs = handler.processIncomingChatMessageForLogs(message, user, message);
            const twitchEmotesByName = handler.extractTwitchEmoteIdNameMap(message, user);

            // NOTE: TwitchBot's internal listener already buffers this message once.
            // Do not call addMessageToBuffer here too — see TwitchBot fix notes.

            const messageLower = message.trim().toLowerCase();
            const customCommandKey = [...customCommands.keys()].find(cmd =>
                messageLower === cmd || messageLower.startsWith(cmd + ' ')
            );

            const userCooldownKey = `${channel}:${loginName}`;

            if (customCommandKey) {
                const customCmd = customCommands.get(customCommandKey);
                if (!userHasCustomCommandRole(user, customCmd.role)) return;

                const cd = isOnCooldown(userCooldowns, userCooldownKey, COOLDOWN_DURATION);
                if (cd.onCooldown) return;
                markCooldown(userCooldowns, userCooldownKey);

                await bot.say(channel, customCmd.response);
                log('COMMAND', `${username} used custom command "${customCommandKey}"`);
                return;
            }

            const imageCommand = imageCommandNames.find(cmd => message.toLowerCase().startsWith(cmd));
            const videoCommand = videoCommandNames.find(cmd => message.toLowerCase().startsWith(cmd));
            const ttsCommand = ttsCommandNames.find(cmd => message.toLowerCase().startsWith(cmd));
            const musicCommand = musicCommandNames.find(cmd => message.toLowerCase().startsWith(cmd));
            let command = commandNames.find(cmd => message.toLowerCase().startsWith(cmd));

            // Mention detection: only trigger on the bot's actual persona name(s) or an
            // explicit @mention — NOT on every unrecognized "!" command (which floods
            // responses to other bots' commands) and not on unanchored substrings.
            let isMention = false;
            if (!command && !imageCommand && !videoCommand && !ttsCommand && !musicCommand) {
                if (shouldRespond(message, BOT_PERSONA_NAMES)) {
                    isMention = true;
                    command = '';
                }
            }

            if (musicCommand) {
                await executeMediaPipeline({ channel, user, message, command: musicCommand, service: 'pollinations', mediaType: 'music', providerCall: (prompt) => pollinationsClient.generateMusic(prompt) });
            } else if (ttsCommand) {
                await executeMediaPipeline({ channel, user, message, command: ttsCommand, service: 'pollinations', mediaType: 'tts', providerCall: (prompt) => pollinationsClient.generateAudio(prompt) });
            } else if (videoCommand) {
                await executeMediaPipeline({ channel, user, message, command: videoCommand, service: 'pollinations', mediaType: 'video', providerCall: (prompt) => pollinationsClient.generateVideo(prompt) });
            } else if (imageCommand) {
                await executeMediaPipeline({ channel, user, message, command: imageCommand, service: 'pollinations', mediaType: 'image', providerCall: (prompt) => pollinationsClient.generateImage(prompt) });
            } else if (command !== undefined && command !== null) {
                const cd = isOnCooldown(userCooldowns, userCooldownKey, USER_COOLDOWN_DURATION);
                if (cd.onCooldown) {
                    if (command) {
                        // Explicit commands tell the user they're on cooldown; passive
                        // mentions just stay quiet to avoid extra chat noise.
                        await bot.say(channel, errorHandler.getMessage('COOLDOWN_ACTIVE', { remainingTime: cd.remaining }));
                    }
                    return;
                }
                markCooldown(userCooldowns, userCooldownKey);

                let text = message;
                if (command && command.length > 0) {
                    text = message.slice(command.length).replace(/^,\s*/, '').trim();
                } else if (isMention) {
                    const mentionRegex = new RegExp(`@?(${BOT_PERSONA_NAMES.join('|')})\\s*`, 'i');
                    text = message.replace(mentionRegex, '').trim();
                    if (!text) text = 'Hello';
                }

                const twitchEmoteNames = handler.extractTwitchEmoteNames(message, user);
                text = handler.flagTwitchEmotesInText(text, twitchEmoteNames);

                const processedUserText = handler.processEmotesForLogs(text);
                const emoteOnlyRegex = /^(?:\s*emote:\S+\s*)+$/;
                if (emoteOnlyRegex.test(processedUserText.trim())) {
                    log('CHAT', `Command ignored: emote-only message from ${username}`);
                    return;
                }

                text = `Message from user ${user.username}: ${text}`;

                try {
                    log('AI', `Request from ${username} in ${channel}: ${text}`);
                    const rawResponse = await aiOps.generateResponse(text, { channel, emoteHandler: handler });
                    const response = handler.sanitizeResponse(rawResponse);

                    let responseWithEmote = response;
                    if (ENABLE_EMOTE_APPENDING === 'true' && !shouldExcludeEmoteAppending(response)) {
                        const emote = getRandomEmote(channel);
                        responseWithEmote = emote ? `${response} ${emote}` : response;
                    }

                    await sendChatResponse(channel, responseWithEmote);
                    log('AI', `Response sent to ${channel}: ${responseWithEmote}`);
                } catch (error) {
                    const reason = errorHandler.createErrorResponse(error);
                    log('ERROR', `DeepSeek call failed: ${reason}`, error);
                    await bot.say(channel, getFallbackResponse());
                }
            }
        });

        twitchBot.onConnected((addr, port) => {
            log('IRC', `Connected to ${addr}:${port}`);
        });

        twitchBot.onDisconnected(reason => {
            log('IRC', `Disconnected: ${reason}`);
        });

        bot = twitchBot;
        aiOps = new AIOperations(
            fileContext,
            DEEPSEEK_API_KEY,
            MODEL_NAME,
            AI_HISTORY_LENGTH,
            ENABLE_SEARCH_GROUNDING,
            YOUTUBE_API_KEY,
            mediaProcessor,
            urlHandler,
            errorHandler,
            systemInstructionBuilder,
            bot
        );

        try {
            await initializeEmotes();
            log('CHAT', 'Emote initialization completed');
        } catch (error) {
            log('ERROR', 'Failed to initialize emotes:', error);
        }

        customCommands = await loadCustomCommands();

        await bot.connect(
            () => log('IRC', 'Bot connected!'),
            error => log('ERROR', "Bot couldn't connect!", error)
        );

        twitchRuntimeStarted = true;
        return true;
    })().catch(error => {
        bot = null;
        aiOps = null;
        twitchRuntimeStarted = false;
        log('ERROR', 'Twitch runtime initialization failed:', error);
        throw error;
    }).finally(() => {
        twitchRuntimePromise = null;
    });

    return twitchRuntimePromise;
}

app.use(express.json({ limit: '1mb' }));
app.use('/public', express.static('public'));

app.ws('/ws', () => {});

app.get('/auth/login', (req, res) => {
    try {
        if (!TWITCH_USERNAME) {
            res.status(500).send('TWITCH_USERNAME is not configured.');
            return;
        }
        res.redirect(buildTwitchAuthUrl(req));
    } catch (error) {
        log('ERROR', 'Failed to build Twitch auth URL:', error);
        res.status(500).send('Failed to start Twitch authorization.');
    }
});

app.get('/auth/callback', async (req, res) => {
    const { code, error, error_description: errorDescription } = req.query;

    if (error) {
        res.status(400).send(`Twitch authorization failed: ${errorDescription || error}`);
        return;
    }
    if (!code) {
        res.status(400).send('Missing authorization code.');
        return;
    }

    try {
        await exchangeCodeForTokens(String(code), getTwitchRedirectUri(req), TWITCH_USERNAME);
        await initializeTwitchRuntime();

        res.type('html').send(`
            <!doctype html>
            <html>
            <head>
                <meta charset="utf-8" />
                <title>Twitch Authorized</title>
                <style>
                    body { font-family: sans-serif; max-width: 720px; margin: 60px auto; padding: 0 20px; line-height: 1.5; }
                    a { color: #9147ff; }
                </style>
            </head>
            <body>
                <h1>Twitch authorization complete</h1>
                <p>The bot account is now connected to this app.</p>
                <p><a href="/">Return to the dashboard</a></p>
            </body>
            </html>
        `);
    } catch (authError) {
        log('ERROR', 'Auth callback failed:', authError);
        res.status(500).send(`Authorization failed: ${authError.message}`);
    }
});

app.get('/auth/status', (_req, res) => {
    res.json({ authorized: isAuthorized(), connected: !!bot });
});

app.get('/api/channels', (_req, res) => {
    res.json(bot ? bot.channels : channels);
});

app.get('/api/channel-ids', (_req, res) => {
    const out = {};
    for (const ch of channels) {
        const clean = ch.replace('#', '').toLowerCase();
        out[ch] = channelIdMap[clean] || null;
    }
    res.json(out);
});

app.get('/api/chat/:channel', async (req, res) => {
    let channel = req.params.channel;
    if (!channel.startsWith('#')) channel = '#' + channel;
    const buffer = await storage.getChatLog(channel);
    res.json(buffer);
});

app.get('/api/media', async (_req, res) => {
    const media = await storage.getMediaLog();
    res.json(media);
});

app.all('/', (req, res) => {
    if (!isAuthorized()) {
        const authUrl = '/auth/login';
        res.type('html').send(`
            <!doctype html>
            <html>
            <head>
                <meta charset="utf-8" />
                <title>Twitch Bot Setup</title>
                <style>
                    body { font-family: sans-serif; max-width: 760px; margin: 60px auto; padding: 0 20px; line-height: 1.6; }
                    a.button { display: inline-block; background: #9147ff; color: white; text-decoration: none; padding: 12px 18px; border-radius: 8px; font-weight: 600; }
                    code { background: #f4f4f4; padding: 2px 6px; border-radius: 4px; }
                </style>
            </head>
            <body>
                <h1>Twitch authorization required</h1>
                <p>This bot is deployed, but the Twitch bot account has not been connected yet.</p>
                <p>Make sure your Twitch application redirect URL is set to:</p>
                <p><code>${getRequestOrigin(req)}/auth/callback</code></p>
                <p>Then log into the Twitch bot account and authorize this app:</p>
                <p><a class="button" href="${authUrl}">Authorize Twitch Bot Account</a></p>
            </body>
            </html>
        `);
        return;
    }

    res.render('pages/index', {
        storageConfigured: storage.configured,
        twitchAuthorized: true,
        twitchConnected: !!bot,
        twitchAuthUrl: '/auth/login'
    });
});

app.get('/ai/:text', async (req, res) => {
    if (!aiOps) {
        res.status(503).send('Bot is not ready yet. Complete Twitch authorization first.');
        return;
    }
    const text = req.params.text;
    try {
        const answer = await aiOps.generateResponse(text);
        res.send(answer);
    } catch (error) {
        log('ERROR', 'Error generating response:', error);
        res.status(500).send('An error occurred while generating the response.');
    }
});

const server = app.listen(PORT, () => {
    log('BOOT', `Server running on port ${PORT}`);
});

// =====================================================================================
// GRACEFUL SHUTDOWN
// -------------------------------------------------------------------------------------
// Render sends SIGTERM on redeploy/restart. Without handling it, in-flight requests and
// the IRC connection get killed abruptly rather than closed cleanly.
// =====================================================================================
let shuttingDown = false;
async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log('BOOT', `Received ${signal}, shutting down gracefully...`);

    server.close(() => log('BOOT', 'HTTP server closed.'));

    if (bot && typeof bot.disconnect === 'function') {
        try {
            await bot.disconnect();
            log('IRC', 'Twitch client disconnected.');
        } catch (error) {
            log('ERROR', 'Error during Twitch disconnect:', error);
        }
    }

    setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (error) => {
    log('ERROR', 'Uncaught exception:', error);
});
process.on('unhandledRejection', (reason) => {
    log('ERROR', 'Unhandled rejection:', reason);
});

// =====================================================================================
// BOOT SEQUENCE
// =====================================================================================
(async () => {
    try {
        await validateStartup();

        const ready = await loadTokens();
        if (ready) {
            await initializeTwitchRuntime();
            await validateStartup(); // re-print summary now that auth/runtime state is known
        } else {
            log('BOOT', 'No stored Twitch authorization found. Waiting for /auth/login.');
        }
    } catch (error) {
        log('ERROR', 'Twitch bootstrap failed:', error);
    }
})();
