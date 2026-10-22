import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEncoderControlApiServer } from '../server/controlApi.mjs';

const ADMIN = 'synthetic-control-admin-secret-for-tests-2026';
const HOST_TOKEN = 'synthetic-control-host-token-for-tests-2026';
const INSTANCE = '11111111-1111-4111-8111-111111111111';

async function withApi(options, run) {
  const server = createEncoderControlApiServer(options);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(origin);
  } finally {
    await new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
  }
}

async function jsonFetch(url, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(url, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, payload: await response.json() };
}

test('standalone control API serves health and rate-limited no-store admin unlock', async () => {
  await withApi({ adminKey: ADMIN, hostToken: HOST_TOKEN }, async origin => {
    const health = await jsonFetch(`${origin}/healthz`);
    assert.equal(health.response.status, 200);
    assert.deepEqual(health.payload, { ok: true, service: 'sweatyobs-control' });

    const unlock = await jsonFetch(`${origin}/api/encoder/admin/unlock`, {
      method: 'POST', body: { key: ADMIN },
    });
    assert.equal(unlock.response.status, 200);
    assert.equal(unlock.response.headers.get('cache-control'), 'no-store');
    assert.equal(unlock.payload.unlocked, true);
    assert.equal(unlock.payload.sessionToken.length, 43);
    assert.equal(unlock.payload.expiresInSeconds, 1200);

    const denied = await jsonFetch(`${origin}/api/encoder/admin/unlock`, {
      method: 'POST', body: { key: 'wrong synthetic secret' },
    });
    assert.equal(denied.response.status, 401);
    assert.equal(JSON.stringify(denied.payload).includes(ADMIN), false);
  });
});

test('standalone phone and host routes coordinate a stream without exposing credentials', async () => {
  await withApi({ adminKey: ADMIN, hostToken: HOST_TOKEN }, async origin => {
    const unlock = await jsonFetch(`${origin}/api/encoder/admin/unlock`, {
      method: 'POST', body: { key: ADMIN },
    });
    const session = `Bearer ${unlock.payload.sessionToken}`;
    const host = { authorization: `Bearer ${HOST_TOKEN}`, 'x-encoder-instance': INSTANCE };

    const initial = await jsonFetch(`${origin}/api/encoder/remote/commands`, { headers: host });
    assert.equal(initial.response.status, 200);
    assert.equal(initial.payload.desiredState, 'STOPPED');

    const accepted = await jsonFetch(`${origin}/api/encoder/remote/actions`, {
      method: 'POST', headers: { authorization: session }, body: { action: 'start' },
    });
    assert.equal(accepted.response.status, 202);
    const started = await jsonFetch(`${origin}/api/encoder/remote/commands?cursor=${encodeURIComponent(initial.payload.cursor)}`, {
      headers: host,
    });
    assert.equal(started.payload.desiredState, 'RUNNING');
    assert.deepEqual(started.payload.commands.map(command => command.action), ['start']);

    const report = await jsonFetch(`${origin}/api/encoder/remote/status`, {
      method: 'POST', headers: host, body: {
        state: 'RUNNING_UNVERIFIED', desiredRunning: true, outputProgress: true,
        outputs: [{ platform: 'twitch', state: 'LIVE_UNVERIFIED', bitrateKbps: 6000,
          reconnects: 0, droppedPackets: null, errorCode: 'NONE' }],
      },
    });
    assert.equal(report.response.status, 202);

    const status = await jsonFetch(`${origin}/api/encoder/remote/status`, { headers: { authorization: session } });
    assert.equal(status.response.status, 200);
    assert.equal(status.payload.hostConnected, true);
    assert.equal(status.payload.outputProgress, true);
    assert.deepEqual(status.payload.outputs.map(output => output.platform), ['twitch']);
    assert.equal(JSON.stringify(status.payload).includes(HOST_TOKEN), false);
    assert.equal(JSON.stringify(status.payload).includes('rtmps://'), false);

    const credentialInjection = await jsonFetch(`${origin}/api/encoder/remote/actions`, {
      method: 'POST', headers: { authorization: session },
      body: { action: 'start', streamKey: 'synthetic-secret-should-not-appear' },
    });
    assert.equal(credentialInjection.response.status, 400);
    assert.equal(JSON.stringify(credentialInjection.payload).includes('synthetic-secret'), false);

    const revoke = await jsonFetch(`${origin}/api/encoder/remote/session/revoke`, {
      method: 'POST', headers: { authorization: session },
    });
    assert.equal(revoke.response.status, 200);
    const afterRevoke = await jsonFetch(`${origin}/api/encoder/remote/status`, { headers: { authorization: session } });
    assert.equal(afterRevoke.response.status, 401);
  });
});

test('control API rejects unconfigured secrets, malformed JSON, and oversized bodies', async () => {
  await withApi({ adminKey: '', hostToken: '' }, async origin => {
    const unconfigured = await jsonFetch(`${origin}/api/encoder/admin/unlock`, {
      method: 'POST', body: { key: ADMIN },
    });
    assert.equal(unconfigured.response.status, 503);

    const invalid = await fetch(`${origin}/api/encoder/remote/actions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad',
    });
    assert.equal(invalid.status, 400);
  });

  await withApi({ adminKey: ADMIN, hostToken: HOST_TOKEN }, async origin => {
    const oversized = await fetch(`${origin}/api/encoder/admin/unlock`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: ADMIN, extra: 'x'.repeat(3000) }),
    });
    assert.equal(oversized.status, 413);
  });
});

test('admin unlock applies atomic failed-guess limits and separates forwarded clients', async () => {
  await withApi({ adminKey: ADMIN, hostToken: HOST_TOKEN, trustProxy: true }, async origin => {
    const firstClient = { 'x-forwarded-for': '203.0.113.10, 10.0.0.1' };
    const concurrent = await Promise.all(Array.from({ length: 6 }, () => jsonFetch(
      `${origin}/api/encoder/admin/unlock`, {
        method: 'POST', headers: firstClient, body: { key: 'wrong synthetic key' },
      })));
    assert.equal(concurrent.filter(item => item.response.status === 401).length, 5);
    assert.equal(concurrent.filter(item => item.response.status === 429).length, 1);

    const validAfterFailures = await jsonFetch(`${origin}/api/encoder/admin/unlock`, {
      method: 'POST', headers: firstClient, body: { key: ADMIN },
    });
    assert.equal(validAfterFailures.response.status, 200, 'valid unlocks do not consume failed-guess quota');

    const separateClient = await jsonFetch(`${origin}/api/encoder/admin/unlock`, {
      method: 'POST', headers: { 'x-forwarded-for': '203.0.113.11' }, body: { key: ADMIN },
    });
    assert.equal(separateClient.response.status, 200);
  });
});

test('valid host heartbeat limit is isolated from unauthenticated traffic behind Render', async () => {
  await withApi({ adminKey: ADMIN, hostToken: HOST_TOKEN, trustProxy: true }, async origin => {
    const forwarded = { 'x-forwarded-for': '203.0.113.20, 10.0.0.1' };
    const denied = await Promise.all(Array.from({ length: 61 }, () => jsonFetch(
      `${origin}/api/encoder/remote/commands`, { headers: forwarded })));
    assert.equal(denied.filter(item => item.response.status === 401).length, 60);
    assert.equal(denied.filter(item => item.response.status === 429).length, 1);

    const hostPoll = await jsonFetch(`${origin}/api/encoder/remote/commands`, {
      headers: { ...forwarded, authorization: `Bearer ${HOST_TOKEN}`, 'x-encoder-instance': INSTANCE },
    });
    assert.equal(hostPoll.response.status, 200, 'invalid callers cannot spend the host process quota');
  });
});

test('admin and remote host secrets must be distinct', () => {
  assert.throws(() => createEncoderControlApiServer({ adminKey: ADMIN, hostToken: ADMIN }), /must be different/);
});

test('SweatyClanker no longer owns SweatyOBS remote API routes', () => {
  const botApp = readFileSync(new URL('../../src/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(botApp, /createEncoderRemoteControl|createEncoderAdminUnlockRouter/);
  assert.doesNotMatch(botApp, /\/api\/encoder\/remote\/(?:commands|actions|status)/);
});
