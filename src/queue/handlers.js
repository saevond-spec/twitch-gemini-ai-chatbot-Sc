import { createLogger } from '../logger/index.js';
const log = createLogger('WORKER');

function notImplemented(name) {
  throw new Error(`${name} is not implemented in SweatyClanker; refusing to mark the job complete`);
}

export const jobHandlers = {
  'analyze-vod': async () => notImplemented('analyze-vod'),
  'generate-clips': async () => notImplemented('generate-clips'),
  'create-thumbnail': async () => notImplemented('create-thumbnail'),
  'stream-summary': async () => notImplemented('stream-summary'),
  'post-social': async () => notImplemented('post-social'),
  'discord-announce': async () => notImplemented('discord-announce'),
  'moderation-review': async ({ channel, user, message, reason, riskScore }) => {
    log.info('Moderation review requested', { channel, user, message, reason, riskScore });
  },
  'memory-cleanup': async () => notImplemented('memory-cleanup'),
};
