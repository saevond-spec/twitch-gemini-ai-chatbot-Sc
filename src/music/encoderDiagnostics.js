import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const DESTINATIONS = new Set(['twitch', 'youtube', 'kick']);
const INGEST_STATES = new Set(['LISTENING', 'CONNECTED', 'PUBLISHING', 'STOPPED', 'FAILED']);
const OUTPUT_STATES = new Set(['STOPPED', 'WAITING FOR KEYFRAME', 'CONNECTING', 'LIVE', 'RETRYING']);
const ERROR_CATEGORIES = new Set([
  'NONE', 'IOException', 'IllegalStateException', 'IllegalArgumentException',
  'SocketTimeoutException', 'UnknownHostException', 'SocketException',
  'SSLException', 'MediaCodec', 'OTHER',
]);
const MODES = new Set(['diagnostic', 'public']);
const TRANSPORTS = new Set(['wifi', 'cellular', 'ethernet', 'other', 'none']);
const FAILURE_PHASES = new Set(['audio_mix', 'relay_gate', 'overlay_config', 'overlay_frame', 'output_queue', 'unknown']);

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION = /^[a-zA-Z0-9._-]{1,32}$/;

function safeEqual(expected, candidate) {
  if (typeof expected !== 'string' || !expected || typeof candidate !== 'string') return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(candidate);
  return left.length === right.length && timingSafeEqual(left, right);
}

function bearer(header) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return '';
  const value = header.slice(7);
  return value.length > 0 && value.length <= 256 ? value : '';
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function boundedInteger(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function normalizeSample(sample) {
  if (!exactKeys(sample, ['sessionId', 'appVersion', 'mode', 'ingest', 'internet', 'destinations', 'failure'])) return null;
  if (typeof sample.sessionId !== 'string' || !SESSION_ID.test(sample.sessionId)) return null;
  if (typeof sample.appVersion !== 'string' || !VERSION.test(sample.appVersion)) return null;
  if (!MODES.has(sample.mode)) return null;

  const ingest = sample.ingest;
  if (!exactKeys(ingest, ['state', 'videoPackets', 'audioPackets', 'tcpConnections'])) return null;
  if (!INGEST_STATES.has(ingest.state) ||
      !boundedInteger(ingest.videoPackets, 0, 1_000_000_000_000) ||
      !boundedInteger(ingest.audioPackets, 0, 1_000_000_000_000) ||
      !boundedInteger(ingest.tcpConnections, 0, 1_000_000_000)) return null;

  const internet = sample.internet;
  if (!exactKeys(internet, ['validated', 'transport']) || typeof internet.validated !== 'boolean' ||
      !TRANSPORTS.has(internet.transport)) return null;

  if (!Array.isArray(sample.destinations) || sample.destinations.length > 3) return null;
  const seen = new Set();
  const destinations = [];
  for (const destination of sample.destinations) {
    if (!exactKeys(destination, ['id', 'state', 'queueBytes', 'queueMs', 'bytesPerSecond', 'reconnects', 'droppedPackets', 'errorCategory'])) return null;
    if (!DESTINATIONS.has(destination.id) || seen.has(destination.id) || !OUTPUT_STATES.has(destination.state) ||
        !boundedInteger(destination.queueBytes, 0, 8_388_608) ||
        !boundedInteger(destination.queueMs, 0, 300_000) ||
        !boundedInteger(destination.bytesPerSecond, 0, 50_000_000) ||
        !boundedInteger(destination.reconnects, 0, 1_000_000_000) ||
        !boundedInteger(destination.droppedPackets, 0, 1_000_000_000_000) ||
        !ERROR_CATEGORIES.has(destination.errorCategory)) return null;
    seen.add(destination.id);
    destinations.push({
      id: destination.id,
      state: destination.state,
      queueBytes: destination.queueBytes,
      queueMs: destination.queueMs,
      bytesPerSecond: destination.bytesPerSecond,
      reconnects: destination.reconnects,
      droppedPackets: destination.droppedPackets,
      errorCategory: destination.errorCategory,
    });
  }

  let failure = null;
  if (sample.failure !== null) {
    if (!exactKeys(sample.failure, ['phase', 'category']) ||
        !FAILURE_PHASES.has(sample.failure.phase) || !ERROR_CATEGORIES.has(sample.failure.category) ||
        sample.failure.category === 'NONE') return null;
    failure = { phase: sample.failure.phase, category: sample.failure.category };
  }

  return {
    sessionId: sample.sessionId,
    appVersion: sample.appVersion,
    mode: sample.mode,
    ingest: {
      state: ingest.state,
      videoPackets: ingest.videoPackets,
      audioPackets: ingest.audioPackets,
      tcpConnections: ingest.tcpConnections,
    },
    internet: { validated: internet.validated, transport: internet.transport },
    destinations,
    failure,
  };
}

/**
 * Short-lived, diagnostics-only upload sessions. The phone uses the existing
 * bridge secret only to mint a scoped token; that token and all reports remain
 * in memory until upload and are never written to a server filesystem/database.
 */
export function createEncoderDiagnostics({
  bridgeToken = '',
  now = () => Date.now(),
  logEvent = () => {},
  tokenTtlMs = 20 * 60 * 1000,
  maxSessions = 128,
} = {}) {
  const enabled = typeof bridgeToken === 'string' && bridgeToken.length >= 32;
  const sessions = new Map(); // SHA-256 token digest -> expiry; never store bearer tokens.

  function pruneExpired() {
    const timestamp = now();
    for (const [key, expiry] of sessions) if (expiry <= timestamp) sessions.delete(key);
  }

  function issueSession(authorization) {
    if (!enabled) return { status: 404, body: { error: 'Encoder diagnostics disabled' } };
    const candidate = bearer(authorization);
    if (!safeEqual(bridgeToken, candidate)) return { status: 401, body: { error: 'Unauthorized' } };
    pruneExpired();
    if (sessions.size >= maxSessions) return { status: 429, body: { error: 'Too many diagnostics sessions' } };
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now() + tokenTtlMs;
    sessions.set(digest(token), expiresAt);
    return { status: 200, body: { token, expiresInSeconds: Math.floor(tokenTtlMs / 1000) } };
  }

  function ingest(authorization, body) {
    if (!enabled) return { status: 404, body: { error: 'Encoder diagnostics disabled' } };
    const candidate = bearer(authorization);
    pruneExpired();
    const expiresAt = candidate ? sessions.get(digest(candidate)) : undefined;
    if (!candidate || !expiresAt || expiresAt <= now()) return { status: 401, body: { error: 'Unauthorized' } };
    if (!exactKeys(body, ['samples']) || !Array.isArray(body.samples) || body.samples.length !== 1) {
      return { status: 400, body: { error: 'Invalid diagnostics report' } };
    }
    const sample = normalizeSample(body.samples[0]);
    if (!sample) return { status: 400, body: { error: 'Invalid diagnostics report' } };
    try {
      logEvent({ kind: 'encoder_connection_sample', receivedAt: new Date(now()).toISOString(), ...sample });
    } catch {
      return { status: 503, body: { error: 'Diagnostics unavailable' } };
    }
    return { status: 202, body: { accepted: 1 } };
  }

  return { enabled, issueSession, ingest };
}
