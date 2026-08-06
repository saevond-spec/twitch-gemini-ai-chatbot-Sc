// plugins/twitch/index.js
import { TwitchClient } from '../../src/twitch/client.js';
import bus from '../../src/bus/index.js';
import { createLogger } from '../../src/logger/index.js';

const log = createLogger('TWITCH-PLUGIN');
let client = null;

export const manifest = {
  name: 'twitch',
  version: '1.0.0',
  description: 'Twitch IRC integration',
  dependencies: [],
};

export async function register(bus, config) {
  log.info('Registering Twitch plugin...');
  client = new TwitchClient();
  global.twitchClient = client;

  client.on('connected', (addr, port) => {
    log.info(`Twitch connected to ${addr}:${port}`);
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

  // --- MESSAGE HANDLER WITH LOG ---
  client.on('message', (channel, user, message, self) => {
    log.info(`📨 PLUGIN: message from ${user.username} in ${channel}: ${message}`);
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
