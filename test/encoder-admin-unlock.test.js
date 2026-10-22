import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createEncoderAdminUnlockRouter } from '../src/security/encoderAdminUnlockRouter.js';

const TEST_KEY = 'synthetic-test-admin-key-not-a-live-credential-2026';

async function withUnlockServer(getAdminKey, run) {
  const app = express();
  app.use('/api/encoder/admin', createEncoderAdminUnlockRouter({ getAdminKey }));
  const server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}/api/encoder/admin/unlock`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test('remote encoder unlock accepts only the configured key over a no-store response', async () => {
  await withUnlockServer(() => TEST_KEY, async url => {
    const accepted = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: TEST_KEY }),
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { unlocked: true });
    assert.equal(accepted.headers.get('cache-control'), 'no-store');

    const rejected = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'incorrect synthetic key' }),
    });
    assert.equal(rejected.status, 401);
    const payload = await rejected.text();
    assert.match(payload, /Key not accepted/);
    assert.equal(payload.includes(TEST_KEY), false);
    assert.equal(rejected.headers.get('cache-control'), 'no-store');
  });
});

test('unlock fails closed when the Render key is missing or too short', async () => {
  for (const configured of ['', 'short']) {
    await withUnlockServer(() => configured, async url => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: TEST_KEY }),
      });
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    });
  }
});

test('failed unlock requests are rate limited without logging or echoing the submitted key', async () => {
  await withUnlockServer(() => TEST_KEY, async url => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const accepted = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: TEST_KEY }),
      });
      assert.equal(accepted.status, 200);
      await accepted.body?.cancel();
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: `wrong-${attempt}` }),
      });
      assert.equal(response.status, 401);
    }
    const limited = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'sixth synthetic failure' }),
    });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('cache-control'), 'no-store');
  });
});
