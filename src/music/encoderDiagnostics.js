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
const EVENT_MODES = new Set(['idle', 'diagnostic', 'public']);
const EVENT_NAMES = new Set([
  'app_opened', 'diagnostics_enabled', 'destination_toggled', 'stream_key_saved', 'server_url_saved',
  'overlay_toggled', 'profile_selected', 'stream_start_requested', 'stream_start_rejected',
  'diagnostic_start_requested', 'diagnostic_start_rejected', 'stop_requested', 'manual_reconnect_requested',
  'manual_reconnect_rejected', 'service_started', 'service_start_failed', 'service_stopped',
  'receiver_listening', 'source_connected', 'source_publishing', 'source_disconnected',
  'ingest_state_changed', 'output_state_changed', 'output_retry', 'stale_packets_dropped',
  'keyframe_wait', 'overlay_ready', 'overlay_fallback', 'music_play', 'music_pause', 'music_skip',
  'music_station_selected', 'music_decode_failed', 'music_bridge_state', 'music_command_applied',
  'safety_warning', 'safety_stop', 'permission_state', 'file_picker_failed', 'metadata_copied',
  'bot_token_saved', 'diagnostic_test_requested', 'setting_changed', 'dashboard_opened',
  'catalog_opened', 'track_selection_saved', 'music_file_selected', 'safety_check_requested',
  'bridge_check_requested', 'ps5_address_saved',
]);
const EVENT_RESULTS = new Set([
  'none', 'requested', 'accepted', 'rejected', 'started', 'failed', 'stopped', 'enabled', 'disabled',
  'connected', 'disconnected', 'publishing', 'live', 'connecting', 'retrying', 'waiting', 'dropped',
  'warning', 'blocked', 'saved', 'selected', 'granted', 'denied', 'applied', 'completed',
]);
const EVENT_TARGETS = new Set([
  'none', 'app', 'diagnostics', 'network', 'permissions', 'settings', 'overlay', 'music',
  'multiple', 'twitch', 'youtube', 'kick',
]);
const EVENT_ERRORS = new Set([
  'NONE', 'IOException', 'IllegalStateException', 'IllegalArgumentException', 'SocketTimeoutException',
  'UnknownHostException', 'SocketException', 'SSLException', 'MediaCodec', 'OTHER', 'MISSING_CONFIG',
  'INVALID_INPUT', 'PERMISSION_DENIED', 'NETWORK_CHANGED', 'PHONE_SAFETY', 'SERVICE_START_DENIED',
  'SOURCE_LOST', 'BRIDGE_AUTH', 'USER_CANCELLED', 'APP_RESTRICTION', 'NO_FILE_PICKER',
]);

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

function normalizeEventBatch(batch) {
  if (!exactKeys(batch, ['sessionId', 'appVersion', 'mode', 'events', 'droppedEvents'])) return null;
  if (typeof batch.sessionId !== 'string' || !SESSION_ID.test(batch.sessionId) ||
      typeof batch.appVersion !== 'string' || !VERSION.test(batch.appVersion) ||
      !EVENT_MODES.has(batch.mode) || !Array.isArray(batch.events) || batch.events.length > 50 ||
      !boundedInteger(batch.droppedEvents, 0, 1_000_000)) return null;
  if (batch.events.length === 0 && batch.droppedEvents === 0) return null;

  const events = [];
  let previousSequence = -1;
  for (const event of batch.events) {
    if (!exactKeys(event, ['sequence', 'name', 'result', 'target', 'errorCategory']) ||
        !boundedInteger(event.sequence, 0, 1_000_000_000_000) || event.sequence <= previousSequence ||
        !EVENT_NAMES.has(event.name) || !EVENT_RESULTS.has(event.result) || !EVENT_TARGETS.has(event.target) ||
        !EVENT_ERRORS.has(event.errorCategory)) return null;
    previousSequence = event.sequence;
    events.push({
      sequence: event.sequence,
      name: event.name,
      result: event.result,
      target: event.target,
      errorCategory: event.errorCategory,
    });
  }
  return {
    sessionId: batch.sessionId,
    appVersion: batch.appVersion,
    mode: batch.mode,
    events,
    droppedEvents: batch.droppedEvents,
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

  function ingestEvents(authorization, body) {
    if (!enabled) return { status: 404, body: { error: 'Encoder diagnostics disabled' } };
    const candidate = bearer(authorization);
    pruneExpired();
    const expiresAt = candidate ? sessions.get(digest(candidate)) : undefined;
    if (!candidate || !expiresAt || expiresAt <= now()) return { status: 401, body: { error: 'Unauthorized' } };
    const batch = normalizeEventBatch(body);
    if (!batch) return { status: 400, body: { error: 'Invalid diagnostics event batch' } };
    try {
      for (const event of batch.events) {
        logEvent({
          kind: 'encoder_app_event',
          receivedAt: new Date(now()).toISOString(),
          sessionId: batch.sessionId,
          appVersion: batch.appVersion,
          mode: batch.mode,
          ...event,
        });
      }
      if (batch.droppedEvents > 0) {
        logEvent({
          kind: 'encoder_telemetry_overflow',
          receivedAt: new Date(now()).toISOString(),
          sessionId: batch.sessionId,
          appVersion: batch.appVersion,
          mode: batch.mode,
          droppedEvents: batch.droppedEvents,
        });
      }
    } catch {
      return { status: 503, body: { error: 'Diagnostics unavailable' } };
    }
    return { status: 202, body: { accepted: batch.events.length, reportedDropped: batch.droppedEvents } };
  }

  return { enabled, issueSession, ingest, ingestEvents };
}
