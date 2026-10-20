import { randomUUID, timingSafeEqual } from 'node:crypto';

function tokenMatches(header, secret) {
  if (!secret || secret.length < 32 || typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createEncoderEventBridge({ token = '', getState, now = () => Date.now(), historyLimit = 128 } = {}) {
  if (typeof getState !== 'function') throw new TypeError('getState must be a function');
  const enabled = typeof token === 'string' && token.length >= 32;
  const generation = randomUUID();
  const limit = Math.max(16, Math.min(256, Math.floor(historyLimit)));
  let sequence = 0;
  let events = [];
  let lastPollAt = 0;

  function publish(message) {
    if (!enabled || message?.type !== 'music.control') return;
    const action = message.action;
    if (!['play', 'pause', 'skip', 'station'].includes(action)) return;
    const station = message.state?.station;
    if (!['club', 'dubstep'].includes(station)) return;
    const command = { sequence: ++sequence, action, station, playing: Boolean(message.state?.playing), timestamp: now() };
    events.push(command);
    if (events.length > limit) events = events.slice(-limit);
  }

  function poll(authorization, cursor = '') {
    if (!enabled) return { status: 404, body: { error: 'Encoder bridge disabled' } };
    if (!tokenMatches(authorization, token)) return { status: 401, body: { error: 'Unauthorized' } };
    const raw = String(cursor || '');
    const separator = raw.lastIndexOf(':');
    const clientGeneration = raw.slice(0, separator);
    const clientSequence = Number(raw.slice(separator + 1));
    const oldest = events.length ? events[0].sequence : sequence + 1;
    const reset = !raw || separator < 0 || clientGeneration !== generation ||
      !Number.isSafeInteger(clientSequence) || clientSequence < oldest - 1 || clientSequence > sequence;
    lastPollAt = now();
    return {
      status: 200,
      body: {
        cursor: generation + ':' + sequence,
        reset,
        state: getState(),
        events: reset ? [] : events.filter(event => event.sequence > clientSequence),
      },
    };
  }

  return { enabled, publish, poll, getLastPollAt: () => lastPollAt };
}
