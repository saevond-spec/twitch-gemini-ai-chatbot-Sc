import tmi from 'tmi.js';
import { sendChatMessage } from './apiClient.js';
import { getUserToken } from './tokenManager.js';

const DEBUG = true;

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

        for (const channel of this.channels) {
            this.messageBuffers.set(this.formatChannel(channel), []);
        }

        if (DEBUG) {
            console.log('[TwitchBot] Initializing instance...');
            console.log('[TwitchBot] Bot username:', this.botUsername);
            console.log('[TwitchBot] Target channels:', this.channels);
        }
    }

    /**
     * Helper to enforce uniform channel naming (#channel)
     */
    formatChannel(channel) {
        const clean = String(channel || '').trim().toLowerCase().replace(/^#/, '');
        return `#${clean}`;
    }

    /**
     * Initializes tmi.Client with a resolved token and sets up internal event listeners.
     */
    async initializeClient() {
        if (DEBUG) console.log('[TwitchBot] Fetching OAuth token for IRC authentication...');
        const token = await getUserToken();

        if (!token) {
            throw new Error('[TwitchBot] Failed to retrieve valid OAuth token.');
        }

        const formattedToken = token.startsWith('oauth:') ? token : `oauth:${token}`;

        if (DEBUG) {
            console.log(`[TwitchBot] Token retrieved (Length: ${token.length}, Prefix: ${token.substring(0, 10)}...)`);
        }

        // Instantiating modern tmi.Client with static credentials
        this.client = new tmi.Client({
            options: {
                debug: DEBUG
            },
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
     * Attaches comprehensive debug and chat event listeners to tmi.js
     */
    attachInternalListeners() {
        if (!this.client) return;

        // ============== RAW & CHAT LOGGING ==============
        this.client.on('message', (channel, userstate, message, self) => {
            const timestamp = new Date().toISOString();
            const displayName = userstate['display-name'] || userstate.username || 'Unknown';
            
            console.log(
                `[CHAT] [${timestamp}] ${channel} | ${displayName} (${self ? 'BOT_SELF' : 'USER'}): ${message}`
            );

            // Buffer message locally
            this.addMessageToBuffer(channel, userstate.username || displayName, message, userstate);

            if (self) {
                if (DEBUG) console.log('[TwitchBot] Self-message ignored for processing.');
                return;
            }

            if (DEBUG) {
                const badges = userstate.badges ? Object.keys(userstate.badges).join(',') : 'none';
                console.log(`[TwitchBot] User Details -> Mod: ${!!userstate.mod} | Subscriber: ${!!userstate.subscriber} | Badges: ${badges}`);
            }
        });

        // ============== CONNECTION LIFECYCLE ==============
        this.client.on('connecting', (address, port) => {
            console.log(`[TwitchBot] Connecting to IRC server ${address}:${port}...`);
        });

        this.client.on('connected', (address, port) => {
            console.log(`[TwitchBot] Connected successfully to ${address}:${port}`);
        });

        this.client.on('disconnected', (reason) => {
            console.warn('[TwitchBot] Disconnected from IRC:', reason);
        });

        this.client.on('reconnect', () => {
            console.log('[TwitchBot] Attempting reconnect...');
        });

        // ============== CHANNEL EVENTS ==============
        this.client.on('join', (channel, username, self) => {
            if (self) {
                console.log(`[TwitchBot] Bot successfully joined channel: ${channel}`);
            } else if (DEBUG) {
                console.log(`[TwitchBot] User joined ${channel}: ${username}`);
            }
        });

        this.client.on('part', (channel, username, self) => {
            if (self) {
                console.log(`[TwitchBot] Bot left channel: ${channel}`);
            } else if (DEBUG) {
                console.log(`[TwitchBot] User parted ${channel}: ${username}`);
            }
        });

        // ============== PROTOCOL & STATE EVENTS ==============
        this.client.on('notice', (channel, msgid, message) => {
            console.warn(`[TwitchBot NOTICE] Channel: ${channel} | ID: ${msgid} | Msg: ${message}`);
        });

        this.client.on('roomstate', (channel, state) => {
            if (DEBUG) console.log(`[TwitchBot ROOMSTATE] Channel: ${channel}`, state);
        });

        this.client.on('userstate', (channel, state) => {
            if (DEBUG) console.log(`[TwitchBot USERSTATE] Channel: ${channel} | Badges:`, state.badges);
        });

        // ============== ERROR HANDLING ==============
        this.client.on('error', (error) => {
            console.error('[TwitchBot] IRC Error encountered:', error);
        });

        // ============== RAW IRC DEBUG ==============
        if (DEBUG && typeof this.client.on === 'function') {
            this.client.on('raw_message', (messageCloned) => {
                if (messageCloned?.raw) {
                    console.log(`[RAW IRC] ${messageCloned.raw}`);
                }
            });
        }
    }

    /**
     * Connects the bot to Twitch IRC.
     * Ensures token is pre-fetched before initializing tmi.Client.
     */
    async connect(onConnected, onDisconnected) {
        try {
            console.log('[TwitchBot] Starting connection sequence...');

            // Step 1: Pre-fetch token and construct tmi.Client
            await this.initializeClient();

            // Step 2: Establish connection
            await this.client.connect();

            console.log('[TwitchBot] IRC Handshake Complete.');

            if (onConnected && typeof onConnected === 'function') {
                onConnected();
            }

        } catch (error) {
            console.error('[TwitchBot] Connection sequence failed:', error);

            if (onDisconnected && typeof onDisconnected === 'function') {
                onDisconnected(error);
            }
        }
    }

    /**
     * Registers an external message listener callback
     */
    onMessage(callback) {
        if (typeof callback !== 'function') {
            throw new TypeError('[TwitchBot] Callback passed to onMessage must be a function.');
        }

        console.log('[TwitchBot] External message handler attached.');

        if (!this.client) {
            console.warn('[TwitchBot] Client not yet initialized. The handler will execute once connected.');
        }

        // Listener wrapper attached to client
        const attachListener = () => {
            this.client.on('message', async (channel, userstate, message, self) => {
                if (self) return;

                if (DEBUG) {
                    console.log(`[TwitchBot] Dispatching message to external callback from ${userstate.username}`);
                }

                try {
                    await callback(channel, userstate, message, self);
                } catch (err) {
                    console.error('[TwitchBot] Uncaught error in external message callback:', err);
                }
            });
        };

        if (this.client) {
            attachListener();
        } else {
            // Defer attaching until after connect() initializes client
            const originalInit = this.initializeClient.bind(this);
            this.initializeClient = async () => {
                await originalInit();
                attachListener();
            };
        }
    }

    onConnected(callback) {
        if (this.client) {
            this.client.on('connected', callback);
        }
    }

    onDisconnected(callback) {
        if (this.client) {
            this.client.on('disconnected', callback);
        }
    }

    /**
     * Sends a chat message via Helix API and buffers it locally.
     */
    async say(channel, message) {
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

            console.log(`[TwitchBot] Outgoing Helix message to ${formattedChannel}: "${message}"`);

            // Primary send via Helix API
            await sendChatMessage(broadcasterId, this.botId, message);

            // Add self message to internal buffer
            this.addMessageToBuffer(formattedChannel, this.botUsername, message, { isBot: true });

        } catch (error) {
            console.error('[TwitchBot] Failed to send chat message:', error?.message || error);
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

        if (this.onLogEntry && typeof this.onLogEntry === 'function') {
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
