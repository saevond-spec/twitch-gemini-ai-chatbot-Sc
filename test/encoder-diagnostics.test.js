import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEncoderDiagnostics } from '../src/music/encoderDiagnostics.js';

const bridgeToken = 'bridge-secret-for-synthetic-tests-only-123456';

function sample(overrides = {}) {
  return {
    sessionId: '123e4567-e89b-12d3-a456-426614174000',
    appVersion: '0.1.8-dev.7',
    mode: 'public',
    ingest: { state: 'PUBLISHING', videoPackets: 1200, audioPackets: 600, tcpConnections: 1 },
    internet: { validated: true, transport: 'wifi' },
    destinations: [{
      id: 'twitch', state: 'LIVE', queueBytes: 0, queueMs: 0, bytesPerSecond: 500000,
      reconnects: 0, droppedPackets: 0, errorCategory: 'NONE',
    }],
    failure: null,
    ...overrides,
  };
}

function eventBatch(overrides = {}) {
  return {
    sessionId: '123e4567-e89b-12d3-a456-426614174000',
    appVersion: '0.1.8-dev.7',
    mode: 'public',
    events: [{ sequence: 1, name: 'manual_reconnect_requested', result: 'requested', target: 'multiple', errorCategory: 'NONE' }],
    droppedEvents: 0,
    ...overrides,
  };
}

test('diagnostics are disabled without a sufficiently long server bridge secret', () => {
  const diagnostics = createEncoderDiagnostics();
  assert.equal(diagnostics.issueSession('Bearer ' + bridgeToken).status, 404);
  assert.equal(diagnostics.ingest('Bearer anything', { samples: [sample()] }).status, 404);
});

test('bridge bearer mints a scoped short-lived upload token; invalid credentials fail closed', () => {
  let now = 1000;
  const diagnostics = createEncoderDiagnostics({ bridgeToken, now: () => now, tokenTtlMs: 60_000 });
  assert.equal(diagnostics.issueSession('Bearer wrong').status, 401);
  const issued = diagnostics.issueSession('Bearer ' + bridgeToken);
  assert.equal(issued.status, 200);
  assert.equal(issued.body.token.length, 43);
  assert.equal(issued.body.expiresInSeconds, 60);
  assert.equal(diagnostics.ingest('Bearer ' + bridgeToken, { samples: [sample()] }).status, 401);
  now += 60_000;
  assert.equal(diagnostics.ingest('Bearer ' + issued.body.token, { samples: [sample()] }).status, 401);
});

test('only strict, bounded connection summaries are sent to remote logs', () => {
  const rows = [];
  const diagnostics = createEncoderDiagnostics({ bridgeToken, logEvent: event => rows.push(event) });
  const session = diagnostics.issueSession('Bearer ' + bridgeToken).body.token;
  assert.deepEqual(diagnostics.ingest('Bearer ' + session, { samples: [sample()] }), {
    status: 202,
    body: { accepted: 1 },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'encoder_connection_sample');
  assert.equal(rows[0].destinations[0].id, 'twitch');
  assert.equal(JSON.stringify(rows).includes('streamKey'), false);
  assert.equal(JSON.stringify(rows).includes('rtmpsUrl'), false);
  assert.equal(JSON.stringify(rows).includes('192.168.1.108'), false);
});

test('media failure reports keep only an allowlisted stage and exception category', () => {
  const rows = [];
  const diagnostics = createEncoderDiagnostics({ bridgeToken, logEvent: event => rows.push(event) });
  const session = diagnostics.issueSession('Bearer ' + bridgeToken).body.token;
  const report = sample({ failure: { phase: 'relay_gate', category: 'IllegalStateException' } });
  assert.equal(diagnostics.ingest('Bearer ' + session, { samples: [report] }).status, 202);
  assert.deepEqual(rows[0].failure, { phase: 'relay_gate', category: 'IllegalStateException' });

  const invalidFailureReports = [
    { phase: 'relay_gate', category: 'OTHER', message: 'private stream detail' },
    { phase: 'raw exception', category: 'IllegalStateException' },
    { phase: 'audio_mix', category: 'arbitrary-class-name' },
    { phase: 'audio_mix', category: 'NONE' },
  ];
  for (const failure of invalidFailureReports) {
    assert.equal(diagnostics.ingest('Bearer ' + session, { samples: [sample({ failure })] }).status, 400);
  }
});

test('accepts only bounded, allowlisted app events and stores sanitized fields', () => {
  const rows = [];
  const diagnostics = createEncoderDiagnostics({ bridgeToken, logEvent: event => rows.push(event) });
  const session = diagnostics.issueSession('Bearer ' + bridgeToken).body.token;
  const batch = eventBatch({ events: [
    { sequence: 2, name: 'manual_reconnect_requested', result: 'requested', target: 'multiple', errorCategory: 'NONE' },
    { sequence: 3, name: 'output_state_changed', result: 'live', target: 'twitch', errorCategory: 'NONE' },
    { sequence: 4, name: 'service_start_failed', result: 'failed', target: 'network', errorCategory: 'SocketTimeoutException' },
  ] });
  assert.deepEqual(diagnostics.ingestEvents('Bearer ' + session, batch), {
    status: 202,
    body: { accepted: 3, reportedDropped: 0 },
  });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].kind, 'encoder_app_event');
  assert.equal(rows[1].target, 'twitch');
  assert.equal(rows[2].errorCategory, 'SocketTimeoutException');
  assert.equal(JSON.stringify(rows).includes('streamKey'), false);
  assert.equal(JSON.stringify(rows).includes('rtmps://'), false);
});

test('event uploads require a scoped session and the HTTP route has a separate bounded rate limit', () => {
  const diagnostics = createEncoderDiagnostics({ bridgeToken });
  assert.equal(diagnostics.ingestEvents('Bearer invalid', eventBatch()).status, 401);

  const appSource = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.match(appSource, /const diagnosticsEventLimiter = rateLimit\(\{ windowMs: 60 \* 1000, max: 10/);
  assert.match(appSource, /app\.post\('\/api\/encoder\/diagnostics\/events', diagnosticsEventLimiter, express\.json\(\{ limit: '12kb' \}\)/);
});

test('rejects event payloads containing raw or arbitrary sensitive fields', () => {
  const diagnostics = createEncoderDiagnostics({ bridgeToken });
  const session = diagnostics.issueSession('Bearer ' + bridgeToken).body.token;
  const sensitiveEvent = eventBatch({ events: [{
    sequence: 1, name: 'server_url_saved', result: 'saved', target: 'youtube', errorCategory: 'NONE',
    serverUrl: 'rtmps://platform.invalid/live', streamKey: 'fake-secret', message: 'private text',
  }] });
  const arbitraryEvent = eventBatch({ events: [{
    sequence: 1, name: 'server_url_saved', result: 'saved', target: 'youtube', errorCategory: 'NONE',
  }] });
  arbitraryEvent.events[0].name = 'saved user provided text';
  const unordered = eventBatch({ events: [
    { sequence: 8, name: 'app_opened', result: 'completed', target: 'app', errorCategory: 'NONE' },
    { sequence: 8, name: 'app_opened', result: 'completed', target: 'app', errorCategory: 'NONE' },
  ] });
  const oversized = eventBatch({ events: Array.from({ length: 51 }, (_, sequence) => ({
    sequence, name: 'app_opened', result: 'completed', target: 'app', errorCategory: 'NONE',
  })) });
  for (const value of [sensitiveEvent, arbitraryEvent, unordered, oversized]) {
    assert.equal(diagnostics.ingestEvents('Bearer ' + session, value).status, 400);
  }
});

test('reports bounded in-memory telemetry overflow without including discarded event data', () => {
  const rows = [];
  const now = 123456;
  const diagnostics = createEncoderDiagnostics({ bridgeToken, now: () => now, logEvent: event => rows.push(event) });
  const session = diagnostics.issueSession('Bearer ' + bridgeToken).body.token;
  assert.equal(diagnostics.ingestEvents('Bearer ' + session, eventBatch({ events: [], droppedEvents: 7 })).status, 202);
  assert.deepEqual(rows[0], {
    kind: 'encoder_telemetry_overflow',
    receivedAt: new Date(now).toISOString(),
    sessionId: '123e4567-e89b-12d3-a456-426614174000',
    appVersion: '0.1.8-dev.7',
    mode: 'public',
    droppedEvents: 7,
  });
});

test('rejects unknown fields, arbitrary strings, duplicate destinations, and oversized counters', () => {
  const diagnostics = createEncoderDiagnostics({ bridgeToken });
  const session = diagnostics.issueSession('Bearer ' + bridgeToken).body.token;
  const cases = [
    sample({ streamKey: 'synthetic-secret' }),
    sample({ destinations: [{ id: 'twitch', state: 'LIVE', queueBytes: 0, queueMs: 0, bytesPerSecond: 1,
      reconnects: 0, droppedPackets: 0, errorCategory: 'NONE', rtmpUrl: 'rtmps://fake.invalid/live' }] }),
    sample({ destinations: [
      { id: 'twitch', state: 'LIVE', queueBytes: 0, queueMs: 0, bytesPerSecond: 1, reconnects: 0, droppedPackets: 0, errorCategory: 'NONE' },
      { id: 'twitch', state: 'LIVE', queueBytes: 0, queueMs: 0, bytesPerSecond: 1, reconnects: 0, droppedPackets: 0, errorCategory: 'NONE' },
    ] }),
    sample({ ingest: { state: 'PUBLISHING', videoPackets: Number.MAX_SAFE_INTEGER, audioPackets: 0, tcpConnections: 1 } }),
  ];
  for (const value of cases) assert.equal(diagnostics.ingest('Bearer ' + session, { samples: [value] }).status, 400);
  assert.equal(diagnostics.ingest('Bearer ' + session, { samples: [sample(), sample()] }).status, 400);
});

test('returns service unavailable if the remote log sink rejects a sanitized event', () => {
  const diagnostics = createEncoderDiagnostics({ bridgeToken, logEvent: () => { throw new Error('sink offline'); } });
  const session = diagnostics.issueSession('Bearer ' + bridgeToken).body.token;
  assert.equal(diagnostics.ingest('Bearer ' + session, { samples: [sample()] }).status, 503);
});
