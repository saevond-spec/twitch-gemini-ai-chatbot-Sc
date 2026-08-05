import tmi from 'tmi.js';
import { sendChatMessage } from './apiClient.js';
import { getUserToken, forceRefresh } from './tokenManager.js';

const DEBUG = process.env.LOG_LEVEL === 'debug';

// Minimum spacing between outgoing Helix chat sends. Twitch's chat-send rate limits
// are per-account (roughly 20 messages / 30s for a regular account, higher for mods) —
// this keeps a conservative floor so bursts (long-message chunking, near-simultaneous
// replies across channels) don't trip 429s. Configurable via env for higher-throughput bots.
const SAY_MIN_INTERVAL_MS = process.env.SAY_MIN_INTERVAL_MS !== undefined
    ? parseInt(process.env.SAY_MIN_INTERVAL_MS, 10)
    : 1200;

// If a disconnect reason matches this, the stored token itself is bad — tmi.js's own
// `reconnect: true` would otherwise retry forever with the same bad credentials.
const AUTH_FAILURE_PATTERN = /authentication failed|improperly formatted auth|login unsuccessful/i;

function log(tag, ...args) {
    const ts = new Date().toISOString();
    const prefix = `[${tag}] [${ts}] [TwitchBot]`;
    if (tag === 'ERROR') {
        console.error(prefix, ...args);
    } else {
        console.log(prefix, ...args);
    }
}

export class TwitchBot {
    constructor(botUsername, channels, botId, channelIdMap) {
        this.channels = Array.isArray(channels) ? channels : [channels];
        this.botId = botId;
        this.channelIdMap = channelIdMap || {};
        this.botUsername = String(botUsername || '').toLowerCase();

        this.client = null;
        this.messageBuffers = new Map();
        this.maxBufferSize = 1000;
        this.onLogEntry = null;

        // Callback registries. Only ONE tmi.js listener is ever attached per event type
        // (in attachInternalListeners); everything registered here is dispatched from
        // that single listener. This is what prevents the double-buffering / duplicate-
        // dispatch bug that existed when onMessage() attached its own second listener.
        this._messageCallbacks = [];
        this._connectedCallbacks = [];
        this._disconnectedCallbacks = [];
        this._eventCallbacks = new Map(); // eventName -> [callback, ...] for raid/sub/etc.

        // Outgoing message queue — see say()/_processQueue().
        this._sendQueue = [];
        this._sending = false;
        this._lastSendAt = 0;

        this._reauthAttempted = false;

        for (const channel of this.channels) {
            this.messageBuffers.set(this.formatChannel(channel), []);
        }

        if (DEBUG) {
            log('IRC', 'Initializing instance...');
            log('IRC', 'Bot username:', this.botUsername);
            log('IRC', 'Target channels:', this.channels);
        }
    }

    formatChannel(channel) {
        const clean = String(channel || '').trim().toLowerCase().replace(/^#/, '');
        return `#${clean}`;
    }

    /**
     * Initializes tmi.Client with a resolved token and attaches internal listeners.
     * Listeners are always attached before connect() is called (see connect()).
     */
    async initializeClient() {
        log('IRC', 'Fetching OAuth token for IRC authentication...');
        const token = await getUserToken();

        if (!token) {
            throw new Error('[TwitchBot] Failed to retrieve valid OAuth token.');
        }

        const formattedToken = token.startsWith('oauth:') ? token : `oauth:${token}`;

        // Never log any portion of the actual token — length only.
        log('IRC', `Token retrieved (length: ${token.length})`);

        this.client = new tmi.Client({
            options: { debug: DEBUG },
            connection: {
                reconnect: true,
                secure: true
            },
            identity: {
                username: this.botUsername,
                password: formattedToken
            },
            channels: this.channels
        });

        this.attachInternalListeners();
    }

    /**
     * The single point where tmi.js events are subscribed. Every event type gets
     * exactly one client.on(...) call here; external registration (onMessage, on, etc.)
     * only pushes into an array that this dispatches to.
     */
    attachInternalListeners() {
        if (!this.client) return;

        // ============== CHAT MESSAGES (PRIVMSG) ==============
        this.client.on('message', async (channel, userstate, message, self) => {
            const timestamp = new Date().toISOString();
            const displayName = userstate['display-name'] || userstate.username || 'Unknown';

            log('CHAT', `[${timestamp}] ${channel} | ${displayName} (${self ? 'BOT_SELF' : 'USER'}): ${message}`);

            // Internal buffering happens exactly once, here.
            this.addMessageToBuffer(channel, userstate.username || displayName, message, userstate);

            if (self) {
                if (DEBUG) log('IRC', 'Self-message ignored for external dispatch.');
                return;
            }

            if (DEBUG) {
                const badges = userstate.badges ? Object.keys(userstate.badges).join(',') : 'none';
                log('IRC', `User details -> Mod: ${!!userstate.mod} | Sub: ${!!userstate.subscriber} | Badges: ${badges}`);
            }

            for (const cb of this._messageCallbacks) {
                try {
                    await cb(channel, userstate, message, self);
                } catch (err) {
                    log('ERROR', 'Uncaught error in external message callback:', err);
                }
            }
        });

        // ============== CONNECTION LIFECYCLE ==============
        this.client.on('connecting', (address, port) => {
            log('IRC', `Connecting to IRC server ${address}:${port}...`);
        });

        this.client.on('connected', (address, port) => {
            log('IRC', `Connected successfully to ${address}:${port}`);
            this._reauthAttempted = false; // reset — a fresh successful auth clears the guard
            for (const cb of this._connectedCallbacks) {
                try { cb(address, port); } catch (err) { log('ERROR', 'connected callback error:', err); }
            }
        });

        this.client.on('disconnected', async (reason) => {
            log('IRC', 'Disconnected from IRC:', reason);

            for (const cb of this._disconnectedCallbacks) {
                try { cb(reason); } catch (err) { log('ERROR', 'disconnected callback error:', err); }
            }

            if (AUTH_FAILURE_PATTERN.test(String(reason || ''))) {
                await this._handleAuthFailure(reason);
            }
        });

        this.client.on('reconnect', () => {
            log('RECOVERY', 'Attempting reconnect...');
        });

        // ============== CHANNEL EVENTS (JOIN / PART) ==============
        this.client.on('join', (channel, username, self) => {
            if (self) {
                log('IRC', `Bot successfully joined channel: ${channel}`);
            } else if (DEBUG) {
                log('IRC', `User joined ${channel}: ${username}`);
            }
        });

        this.client.on('part', (channel, username, self) => {
            if (self) {
                log('IRC', `Bot left channel: ${channel}`);
            } else if (DEBUG) {
                log('IRC', `User parted ${channel}: ${username}`);
            }
        });

        // ============== PROTOCOL & STATE EVENTS ==============
        this.client.on('notice', (channel, msgid, message) => {
            log('IRC', `NOTICE | Channel: ${channel} | ID: ${msgid} | Msg: ${message}`);
            this._dispatchEvent('notice', channel, msgid, message);
        });

        this.client.on('roomstate', (channel, state) => {
            if (DEBUG) log('IRC', `ROOMSTATE | Channel: ${channel}`, state);
        });

        this.client.on('userstate', (channel, state) => {
            if (DEBUG) log('IRC', `USERSTATE | Channel: ${channel} | Badges:`, state.badges);
        });

        // ============== MODERATION EVENTS (CLEARCHAT / CLEARMSG) ==============
        // tmi.js splits raw CLEARCHAT into 'clearchat' (full channel clear), 'timeout',
        // and 'ban'. CLEARMSG (single deleted message) is 'messagedeleted'.
        this.client.on('clearchat', (channel) => {
            log('IRC', `CLEARCHAT | Channel ${channel} chat cleared`);
            this._dispatchEvent('clearchat', channel);
        });

        this.client.on('timeout', (channel, username, reason, duration) => {
            log('IRC', `TIMEOUT | ${username} in ${channel} for ${duration}s (${reason || 'no reason given'})`);
            this._dispatchEvent('timeout', channel, username, reason, duration);
        });

        this.client.on('ban', (channel, username, reason) => {
            log('IRC', `BAN | ${username} in ${channel} (${reason || 'no reason given'})`);
            this._dispatchEvent('ban', channel, username, reason);
        });

        this.client.on('messagedeleted', (channel, username, deletedMessage, userstate) => {
            log('IRC', `CLEARMSG | Deleted message from ${username} in ${channel}: ${deletedMessage}`);
            this._dispatchEvent('messagedeleted', channel, username, deletedMessage, userstate);
        });

        // ============== USERNOTICE-FAMILY EVENTS (raids/subs/gifts) ==============
        // tmi.js parses raw USERNOTICE into these specific, higher-level events rather
        // than exposing a single raw 'usernotice' — all are wired here so raid/hype-train/
        // sub reactions (per the auto-response spec) have real events to hook into.
        this.client.on('raided', (channel, username, viewers) => {
            log('IRC', `RAID | ${channel} raided by ${username} with ${viewers} viewers`);
            this._dispatchEvent('raided', channel, username, viewers);
        });

        this.client.on('subscription', (channel, username, methods, message, userstate) => {
            log('IRC', `SUB | ${username} subscribed in ${channel}`);
            this._dispatchEvent('subscription', channel, username, methods, message, userstate);
        });

        this.client.on('resub', (channel, username, months, message, userstate, methods) => {
            log('IRC', `RESUB | ${username} resubscribed in ${channel} (${months} months)`);
            this._dispatchEvent('resub', channel, username, months, message, userstate, methods);
        });

        this.client.on('subgift', (channel, username, streakMonths, recipient, methods, userstate) => {
            log('IRC', `SUBGIFT | ${username} gifted a sub to ${recipient} in ${channel}`);
            this._dispatchEvent('subgift', channel, username, streakMonths, recipient, methods, userstate);
        });

        this.client.on('submysterygift', (channel, username, numbOfSubs, methods, userstate) => {
            log('IRC', `MYSTERYGIFT | ${username} gifted ${numbOfSubs} subs in ${channel}`);
            this._dispatchEvent('submysterygift', channel, username, numbOfSubs, methods, userstate);
        });

        this.client.on('primepaidupgrade', (channel, username, methods) => {
            this._dispatchEvent('primepaidupgrade', channel, username, methods);
        });

        this.client.on('anongiftpaidupgrade', (channel, username, userstate) => {
            this._dispatchEvent('anongiftpaidupgrade', channel, username, userstate);
        });

        // ============== WHISPERS ==============
        this.client.on('whisper', (from, userstate, message, self) => {
            if (self) return;
            log('IRC', `WHISPER | From ${from}: ${message}`);
            this._dispatchEvent('whisper', from, userstate, message, self);
        });

        // ============== ERROR HANDLING ==============
        this.client.on('error', (error) => {
            log('ERROR', 'IRC Error encountered:', error);
        });

        // NOTE: PING/PONG are handled transparently at the protocol level by tmi.js —
        // there is no application-level action needed for either.

        // ============== RAW IRC DEBUG ==============
        if (DEBUG && typeof this.client.on === 'function') {
            this.client.on('raw_message', (messageCloned) => {
                if (messageCloned?.raw) {
                    log('IRC', `[RAW] ${messageCloned.raw}`);
                }
            });
        }
    }

    _dispatchEvent(eventName, ...args) {
        const callbacks = this._eventCallbacks.get(eventName);
        if (!callbacks) return;
        for (const cb of callbacks) {
            try {
                cb(...args);
            } catch (err) {
                log('ERROR', `Uncaught error in '${eventName}' callback:`, err);
            }
        }
    }

    /**
     * Generic registration for events beyond 'message'/'connected'/'disconnected'
     * (raid, subscription, clearchat, whisper, etc.) — used to wire auto-responses.
     */
    on(eventName, callback) {
        if (typeof callback !== 'function') {
            throw new TypeError('[TwitchBot] callback passed to on() must be a function.');
        }
        if (!this._eventCallbacks.has(eventName)) {
            this._eventCallbacks.set(eventName, []);
        }
        this._eventCallbacks.get(eventName).push(callback);
    }

    /**
     * Handles a token-related disconnect: forces a refresh against the stored refresh
     * token and re-establishes the client with a fresh token, rather than letting
     * tmi.js's built-in reconnect retry forever against the same bad credentials.
     * Guarded against looping if the refresh token itself turns out to be invalid.
     */
    async _handleAuthFailure(reason) {
        if (this._reauthAttempted) {
            log('ERROR', `Auth failure persisted after refresh attempt (reason: ${reason}). Manual re-authorization via /auth/login is required.`);
            return;
        }
        this._reauthAttempted = true;

        log('RECOVERY', `Auth failure detected (${reason}). Forcing token refresh and reconnecting...`);

        try {
            await forceRefresh();
        } catch (err) {
            log('ERROR', 'Token refresh failed during auth-failure recovery. Manual re-authorization required:', err.message);
            return;
        }

        try {
            if (this.client) {
                try { this.client.removeAllListeners(); } catch { /* best effort */ }
                try { await this.client.disconnect(); } catch { /* already disconnected */ }
            }
            await this.initializeClient();
            await this.client.connect();
            log('RECOVERY', 'Reconnected successfully with refreshed token.');
        } catch (err) {
            log('ERROR', 'Failed to reconnect after token refresh:', err);
        }
    }

    /**
     * Connects the bot to Twitch IRC. Listeners are always attached (inside
     * initializeClient -> attachInternalListeners) before client.connect() runs.
     */
    async connect(onConnected, onDisconnected) {
        try {
            log('IRC', 'Starting connection sequence...');

            await this.initializeClient();
            await this.client.connect();

            log('IRC', 'IRC handshake complete.');

            if (typeof onConnected === 'function') onConnected();
        } catch (error) {
            log('ERROR', 'Connection sequence failed:', error);
            if (typeof onDisconnected === 'function') onDisconnected(error);
        }
    }

    async disconnect() {
        if (!this.client) return;
        try {
            await this.client.disconnect();
        } catch (err) {
            log('ERROR', 'Error during disconnect:', err);
        }
    }

    /**
     * Registers an external chat-message callback. Does NOT attach its own tmi.js
     * listener (that was the source of the duplicate-dispatch bug) — it only pushes
     * into the array that attachInternalListeners()'s single 'message' handler drains.
     */
    onMessage(callback) {
        if (typeof callback !== 'function') {
            throw new TypeError('[TwitchBot] Callback passed to onMessage must be a function.');
        }
        log('IRC', 'External message handler attached.');
        this._messageCallbacks.push(callback);
    }

    /**
     * Registers a connected-event callback. Safe to call before connect() — the
     * callback is buffered and will fire once the client actually connects, unlike
     * the previous implementation which silently dropped it if called too early.
     */
    onConnected(callback) {
        if (typeof callback === 'function') this._connectedCallbacks.push(callback);
    }

    onDisconnected(callback) {
        if (typeof callback === 'function') this._disconnectedCallbacks.push(callback);
    }

    /**
     * Sends a chat message via Helix API. Queued and spaced (SAY_MIN_INTERVAL_MS) to
     * stay under Twitch's chat-send rate limits. Returns true/false so callers can
     * detect and react to failures instead of them being silently swallowed.
     */
    async say(channel, message) {
        return new Promise((resolve) => {
            this._sendQueue.push({ channel, message, resolve });
            this._processQueue();
        });
    }

    async _processQueue() {
        if (this._sending) return;
        this._sending = true;

        while (this._sendQueue.length > 0) {
            const elapsed = Date.now() - this._lastSendAt;
            if (elapsed < SAY_MIN_INTERVAL_MS) {
                await new Promise(r => setTimeout(r, SAY_MIN_INTERVAL_MS - elapsed));
            }

            const { channel, message, resolve } = this._sendQueue.shift();
            const success = await this._sendNow(channel, message);
            this._lastSendAt = Date.now();
            resolve(success);
        }

        this._sending = false;
    }

    async _sendNow(channel, message) {
        try {
            const formattedChannel = this.formatChannel(channel);
            const cleanChannel = formattedChannel.replace('#', '');
            const broadcasterId = this.channelIdMap[cleanChannel];

            if (!broadcasterId) {
                throw new Error(`Broadcaster ID missing for channel: ${channel}`);
            }
            if (!this.botId) {
                throw new Error('Bot ID (User ID) is missing.');
            }

            log('IRC', `Outgoing Helix message to ${formattedChannel}: "${message}"`);

            await sendChatMessage(broadcasterId, this.botId, message);

            this.addMessageToBuffer(formattedChannel, this.botUsername, message, { isBot: true });
            return true;
        } catch (error) {
            log('ERROR', 'Failed to send chat message:', error?.message || error);
            return false;
        }
    }

    /**
     * Buffers incoming or outgoing messages in memory.
     */
    addMessageToBuffer(channel, username, message, meta = null) {
        const formattedChannel = this.formatChannel(channel);

        if (!this.messageBuffers.has(formattedChannel)) {
            this.messageBuffers.set(formattedChannel, []);
        }

        const buffer = this.messageBuffers.get(formattedChannel);

        const entry = {
            username: String(username || '').toLowerCase(),
            message,
            timestamp: Date.now(),
            meta: meta && typeof meta === 'object' ? meta : null
        };

        buffer.push(entry);

        if (buffer.length > this.maxBufferSize) {
            buffer.shift();
        }

        if (typeof this.onLogEntry === 'function') {
            this.onLogEntry(formattedChannel, entry);
        }

        return entry;
    }

    /**
     * Retrieves recent messages from buffer excluding commands and bot self-messages.
     */
    getRecentMessages(channel, count = 10, commandNames = []) {
        const formattedChannel = this.formatChannel(channel);
        const buffer = this.messageBuffers.get(formattedChannel);

        if (!buffer) return [];

        const normalizedCommands = commandNames.map(cmd => String(cmd).toLowerCase().trim());

        return buffer
            .slice(-count)
            .filter(entry => {
                const msg = String(entry.message || '').toLowerCase().trim();
                const isCommand = normalizedCommands.some(cmd => msg.startsWith(cmd));
                const isMe = String(entry.username || '').toLowerCase() === this.botUsername;
                return !isCommand && !isMe;
            })
            .map(entry => `${entry.username}: ${entry.message}`);
    }
}
