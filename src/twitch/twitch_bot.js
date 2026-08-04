import tmi from 'tmi.js';
import { sendChatMessage } from './apiClient.js';
import { getUserToken } from './tokenManager.js';

// Enable debug logging for this file
const DEBUG = true;

export class TwitchBot {
    constructor(botUsername, channels, botId, channelIdMap) {
        this.channels = channels;
        this.botId = botId;
        this.channelIdMap = channelIdMap || {};
        this.botUsername = String(botUsername || '').toLowerCase();

        if (DEBUG) {
            console.log('[TwitchBot] Initializing...');
            console.log('[TwitchBot] Bot username:', this.botUsername);
            console.log('[TwitchBot] Joining channels:', this.channels);
        }

        this.client = new tmi.client({
            connection: {
                reconnect: true,
                secure: true
            },
            identity: {
                username: botUsername,
                password: async () => {
                    const token = await getUserToken();
                    return `oauth:${token}`;
                }
            },
            channels: this.channels
        });

        this.messageBuffers = new Map();
        this.maxBufferSize = 1000;

        for (const channel of channels) {
            this.messageBuffers.set(channel, []);
        }

        this.onLogEntry = null;

        // ============== RAW CHAT DEBUG (EXTENDED) ==============
        this.client.on('message', (channel, userstate, message, self) => {
            // Log EVERY message, including the bot's own (for debugging)
            const timestamp = new Date().toISOString();
            console.log(
                `[RAW CHAT ${timestamp}] ${channel} | ${userstate['display-name'] || userstate.username} (${self ? 'SELF' : 'USER'}): ${message}`
            );

            // If it's a self-message, we still log it but won't process further
            if (self) {
                // Optionally log that we skipped it
                if (DEBUG) {
                    console.log('[TwitchBot] Skipping self-message');
                }
                return;
            }

            // Additional debug: log badges and mod status
            if (DEBUG) {
                const badges = userstate.badges ? Object.keys(userstate.badges).join(',') : 'none';
                console.log(`[TwitchBot] User: ${userstate.username} | Badges: ${badges} | Mod: ${userstate.mod || false}`);
            }
        });

        // ============== JOIN DEBUG ==============
        this.client.on('join', (channel, username, self) => {
            if (self) {
                console.log(`[TwitchBot] Successfully joined ${channel}`);
            } else {
                console.log(`[TwitchBot] ${username} joined ${channel}`);
            }
        });

        this.client.on('part', (channel, username, self) => {
            if (self) {
                console.log(`[TwitchBot] Left ${channel}`);
            } else {
                console.log(`[TwitchBot] ${username} left ${channel}`);
            }
        });

        this.client.on('connected', (addr, port) => {
            console.log(`[TwitchBot] Connected to ${addr}:${port}`);
        });

        this.client.on('disconnected', (reason) => {
            console.log('[TwitchBot] Disconnected:', reason);
        });

        this.client.on('reconnect', () => {
            console.log('[TwitchBot] Reconnecting...');
        });

        // ============== ERROR LOGGING ==============
        this.client.on('error', (error) => {
            console.error('[TwitchBot] Client error:', error);
        });
    }

    async connect(onConnected, onDisconnected) {
        try {
            console.log('[TwitchBot] Connecting...');

            // Force token refresh before connecting
            await getUserToken();

            await this.client.connect();

            console.log('[TwitchBot] Connection successful');

            if (onConnected) {
                onConnected();
            }

        } catch (error) {
            console.error('[TwitchBot] Connection failed:', error);

            if (onDisconnected) {
                onDisconnected(error);
            }
        }
    }

    onMessage(callback) {
        console.log('[TwitchBot] Message handler attached');

        this.client.on(
            'message',
            async (channel, userstate, message, self) => {
                // Skip self messages
                if (self) {
                    if (DEBUG) {
                        console.log('[TwitchBot] onMessage: Skipping self-message');
                    }
                    return;
                }

                // Log that we're about to call the callback
                console.log(
                    `[TwitchBot] onMessage -> calling callback for ${userstate.username}: "${message}"`
                );

                try {
                    await callback(
                        channel,
                        userstate,
                        message,
                        self
                    );
                } catch (err) {
                    console.error('[TwitchBot] Error in message callback:', err);
                }
            }
        );
    }

    onConnected(callback) {
        this.client.on('connected', callback);
    }

    onDisconnected(callback) {
        this.client.on('disconnected', callback);
    }

    async say(channel, message) {
        try {
            const cleanChannel = channel
                .replace('#', '')
                .toLowerCase();

            const broadcasterId = this.channelIdMap[cleanChannel];

            if (!broadcasterId) {
                throw new Error(
                    `Broadcaster ID not found for ${channel}`
                );
            }

            if (!this.botId) {
                throw new Error(
                    'Bot ID is missing'
                );
            }

            console.log(
                `[TwitchBot] Sending message to ${channel}: ${message}`
            );

            await sendChatMessage(
                broadcasterId,
                this.botId,
                message
            );

            this.addMessageToBuffer(
                channel,
                this.botUsername,
                message
            );

        } catch (error) {

            console.error(
                '[TwitchBot] Failed to send message:',
                error.message || error
            );
        }
    }

    addMessageToBuffer(channel, username, message, meta = null) {

        if (!this.messageBuffers.has(channel)) {
            this.messageBuffers.set(channel, []);
        }

        const buffer = this.messageBuffers.get(channel);

        const entry = {
            username,
            message,
            timestamp: Date.now(),
            meta: meta && typeof meta === 'object'
                ? meta
                : null
        };

        buffer.push(entry);

        if (buffer.length > this.maxBufferSize) {
            buffer.shift();
        }

        if (this.onLogEntry) {
            this.onLogEntry(channel, entry);
        }

        return entry;
    }


    getRecentMessages(channel, count = 10, commandNames = []) {

        const buffer = this.messageBuffers.get(channel);

        if (!buffer) {
            return [];
        }

        return buffer
            .slice(-count)
            .filter(entry => {

                const message =
                    String(entry.message || '')
                    .toLowerCase()
                    .trim();

                const isCommand =
                    commandNames.some(cmd =>
                        message.startsWith(cmd)
                    );

                const isMe =
                    String(entry.username || '')
                    .toLowerCase() === this.botUsername;

                return !isCommand && !isMe;
            })
            .map(entry =>
                `${entry.username}: ${entry.message}`
            );
    }
}
