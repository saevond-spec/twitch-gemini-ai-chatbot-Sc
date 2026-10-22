import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const ACTIONS = new Set(['start', 'stop', 'reconnect', 'play', 'pause', 'skip', 'station']);
const STATIONS = new Set(['club', 'dubstep']);
const PLATFORMS = new Set(['twitch', 'youtube', 'kick']);
const HOST_STATES = new Set([
  'STOPPED', 'STARTING', 'WAITING_FOR_INGEST', 'RUNNING_UNVERIFIED', 'RETRYING', 'FAILED',
]);
const OUTPUT_STATES = new Set([
  'STOPPED', 'CONNECTING', 'LIVE_UNVERIFIED', 'RETRYING', 'FAILED', 'UNKNOWN',
]);
const ERROR_CODES = new Set(['NONE', 'NETWORK', 'AUTH', 'SOURCE', 'ENCODER', 'UNKNOWN']);

function digest(value) {
  return createHash('sha256').update(value).digest();
}

function constantTimeEqual(expected, candidate) {
  if (typeof expected !== 'string' || typeof candidate !== 'string' || !expected || !candidate) return false;
  return timingSafeEqual(digest(expected), digest(candidate));
}

function bearer(header) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return '';
  const value = header.slice(7);
  return value.length > 0 && value.length <= 256 ? value : '';
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function validHostInstanceId(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeHostStatus(value) {
  if (!exactKeys(value, ['state', 'desiredRunning', 'outputProgress', 'outputs']) ||
      !HOST_STATES.has(value.state) || typeof value.outputProgress !== 'boolean' ||
      typeof value.desiredRunning !== 'boolean' ||
      !Array.isArray(value.outputs) || value.outputs.length > 3) return null;

  const seen = new Set();
  const outputs = [];
  for (const output of value.outputs) {
    if (!exactKeys(output, ['platform', 'state', 'bitrateKbps', 'reconnects', 'droppedPackets', 'errorCode']) ||
        !PLATFORMS.has(output.platform) || seen.has(output.platform) || !OUTPUT_STATES.has(output.state) ||
        !(output.bitrateKbps === null || (Number.isSafeInteger(output.bitrateKbps) && output.bitrateKbps >= 0 && output.bitrateKbps <= 100_000)) ||
        !Number.isSafeInteger(output.reconnects) || output.reconnects < 0 || output.reconnects > 1_000_000_000 ||
        !(output.droppedPackets === null || (Number.isSafeInteger(output.droppedPackets) && output.droppedPackets >= 0 && output.droppedPackets <= 1_000_000_000_000)) ||
        !ERROR_CODES.has(output.errorCode)) return null;
    seen.add(output.platform);
    outputs.push({
      platform: output.platform,
      state: output.state,
      bitrateKbps: output.bitrateKbps,
      reconnects: output.reconnects,
      droppedPackets: output.droppedPackets,
      errorCode: output.errorCode,
    });
  }
  return { state: value.state, desiredRunning: value.desiredRunning, outputProgress: value.outputProgress, outputs };
}

/**
 * Low-bandwidth control plane. Stream keys, RTMP URLs, and media are deliberately
 * absent from the phone-facing protocol. Session and desired state are in
 * memory; the server fails closed to STOPPED after a process restart.
 */
export function createEncoderRemoteControl({
  hostToken = '',
  now = () => Date.now(),
  sessionTtlMs = 20 * 60 * 1000,
  hostTimeoutMs = 20_000,
  maxSessions = 128,
  historyLimit = 128,
} = {}) {
  const enabled = typeof hostToken === 'string' && hostToken.length >= 32;
  const generation = randomUUID();
  const sessions = new Map(); // SHA-256 token digest -> expiry.
  const limit = Math.max(16, Math.min(256, Math.floor(historyLimit)));
  let sequence = 0;
  let commands = [];
  let desiredState = 'STOPPED';
  let lastHostAt = 0;
  let hostInstanceId = '';
  let hostStatus = { state: 'STOPPED', desiredRunning: false, outputProgress: false, outputs: [] };

  function hostConnected() {
    return lastHostAt > 0 && now() - lastHostAt <= hostTimeoutMs;
  }

  function pruneSessions() {
    const time = now();
    for (const [key, expiry] of sessions) if (expiry <= time) sessions.delete(key);
  }

  function issueSession() {
    pruneSessions();
    if (sessions.size >= maxSessions) {
      const oldest = sessions.keys().next().value;
      if (oldest) sessions.delete(oldest);
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now() + sessionTtlMs;
    sessions.set(digest(token).toString('hex'), expiresAt);
    return { sessionToken: token, expiresInSeconds: Math.floor(sessionTtlMs / 1000) };
  }

  function validSession(header) {
    pruneSessions();
    const token = bearer(header);
    if (!token) return false;
    const key = digest(token).toString('hex');
    return sessions.has(key) && sessions.get(key) > now();
  }

  function validBridge(header) {
    const token = bearer(header);
    return enabled && constantTimeEqual(hostToken, token);
  }

  function revokeSession(authorization) {
    const token = bearer(authorization);
    if (!token) return { status: 401, body: { error: 'Remote control session expired or invalid.' } };
    const removed = sessions.delete(digest(token).toString('hex'));
    return removed
      ? { status: 200, body: { revoked: true } }
      : { status: 401, body: { error: 'Remote control session expired or invalid.' } };
  }

  function submitAction(authorization, body) {
    if (!validSession(authorization)) return { status: 401, body: { error: 'Remote control session expired or invalid.' } };
    if (!enabled) return { status: 503, body: { error: 'Remote encoder host bridge is not configured.' } };
    if (!body || typeof body !== 'object' || Array.isArray(body) || !ACTIONS.has(body.action)) {
      return { status: 400, body: { error: 'Unsupported remote action.' } };
    }
    const expectedKeys = body.action === 'station' ? ['action', 'station'] : ['action'];
    if (!exactKeys(body, expectedKeys) || (body.action === 'station' && !STATIONS.has(body.station))) {
      return { status: 400, body: { error: 'Invalid remote action fields.' } };
    }
    if ((body.action === 'start' || body.action === 'reconnect') && !hostConnected()) {
      return { status: 409, body: { error: 'Remote encoder host is offline. Connect the host before starting or reconnecting.' } };
    }
    if (body.action === 'reconnect' && desiredState !== 'RUNNING') {
      return { status: 409, body: { error: 'No remote stream is marked running. Start it first.' } };
    }
    if (body.action === 'start') desiredState = 'RUNNING';
    if (body.action === 'stop') {
      desiredState = 'STOPPED';
      // A pending START must not run briefly when a disconnected host returns.
      commands = commands.filter(command => command.action !== 'start' && command.action !== 'reconnect');
    }
    const command = { id: randomUUID(), sequence: ++sequence, action: body.action };
    if (body.station) command.station = body.station;
    command.timestamp = now();
    commands.push(command);
    if (commands.length > limit) commands = commands.slice(-limit);
    return {
      status: 202,
      body: { accepted: true, commandId: command.id, desiredState, hostConnected: hostConnected() },
    };
  }

  function hostPoll(authorization, cursor = '', instanceId = '') {
    if (!enabled) return { status: 404, body: { error: 'Remote encoder bridge is disabled.' } };
    if (!validBridge(authorization)) return { status: 401, body: { error: 'Unauthorized.' } };
    if (!validHostInstanceId(instanceId)) return { status: 400, body: { error: 'Invalid host instance.' } };
    if (hostInstanceId && hostInstanceId !== instanceId && hostConnected()) {
      return { status: 409, body: {
        code: 'HOST_INSTANCE_ACTIVE',
        error: 'Another encoder host instance is still active.',
      } };
    }
    // Each encoder process has a fresh identity. Do not replay a RUNNING intent
    // into a newly restarted process; it must receive a new explicit Start.
    if (hostInstanceId && hostInstanceId !== instanceId && desiredState === 'RUNNING') {
      desiredState = 'STOPPED';
      commands = [];
    }
    if (hostInstanceId !== instanceId) {
      hostInstanceId = instanceId;
      hostStatus = { state: 'STOPPED', desiredRunning: false, outputProgress: false, outputs: [] };
    }
    // A START that was never observed by an active host is discarded after the
    // heartbeat lease. A host that reported a running intent may keep its
    // already-started stream alive during a control API outage and resume polls.
    if (desiredState === 'RUNNING' && !hostConnected() && !hostStatus.desiredRunning) {
      desiredState = 'STOPPED';
      commands = [];
    }
    const raw = String(cursor || '');
    const separator = raw.lastIndexOf(':');
    const cursorGeneration = raw.slice(0, separator);
    const cursorSequence = Number(raw.slice(separator + 1));
    const oldest = commands.length ? commands[0].sequence : sequence + 1;
    const reset = !raw || separator < 0 || cursorGeneration !== generation ||
      !Number.isSafeInteger(cursorSequence) || cursorSequence < oldest - 1 || cursorSequence > sequence;
    lastHostAt = now();
    return {
      status: 200,
      body: {
        cursor: generation + ':' + sequence,
        reset,
        desiredState,
        hostStatus,
        commands: reset ? [] : commands.filter(command => command.sequence > cursorSequence),
      },
    };
  }

  function reportHostStatus(authorization, body, instanceId = '') {
    if (!enabled) return { status: 404, body: { error: 'Remote encoder bridge is disabled.' } };
    if (!validBridge(authorization)) return { status: 401, body: { error: 'Unauthorized.' } };
    if (!validHostInstanceId(instanceId) || instanceId !== hostInstanceId) {
      return { status: 409, body: { code: 'HOST_INSTANCE_CHANGED', error: 'Host instance changed.' } };
    }
    const normalized = normalizeHostStatus(body);
    if (!normalized) return { status: 400, body: { error: 'Invalid host status.' } };
    hostStatus = normalized;
    lastHostAt = now();
    return { status: 202, body: { accepted: true } };
  }

  function phoneStatus(authorization) {
    if (!validSession(authorization)) return { status: 401, body: { error: 'Remote control session expired or invalid.' } };
    if (!enabled) return { status: 200, body: { configured: false, hostConnected: false, desiredState, state: 'NOT_CONFIGURED', outputs: [] } };
    const connected = hostConnected();
    return {
      status: 200,
      body: {
        configured: true,
        hostConnected: connected,
        desiredState,
        state: connected ? hostStatus.state : 'OFFLINE',
        outputProgress: connected && hostStatus.outputProgress,
        outputs: connected ? hostStatus.outputs : [],
        heartbeatAgeMs: connected ? Math.max(0, now() - lastHostAt) : null,
      },
    };
  }

  return {
    enabled,
    issueSession,
    isValidSession: validSession,
    isValidBridge: validBridge,
    revokeSession,
    submitAction,
    hostPoll,
    reportHostStatus,
    phoneStatus,
  };
}
