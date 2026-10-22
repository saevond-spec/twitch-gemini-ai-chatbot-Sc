import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPacket, pollOnce } from '../encoder/bridge-client.mjs';

test('restart resync restores selected station, volume and paused state, skipping stale events', () => {
  const calls = [];
  const feeder = { command: (...args) => calls.push(args), setVolume: value => calls.push(['volume', value]) };
  applyPacket(feeder, {
    cursor: 'generation:8', reset: true,
    state: { station: 'club', playing: false, volumePercent: 30 }, events: [{ action: 'skip' }],
  });
  assert.deepEqual(calls, [['station', 'club'], ['volume', 30], ['pause']]);
});

test('command sync applies only supported controls', () => {
  const calls = [];
  const feeder = { command: (...args) => calls.push(args), setVolume: value => calls.push(['volume', value]) };
  const cursor = applyPacket(feeder, {
    cursor: 'generation:9', reset: false, state: {},
    events: [
      { action: 'play' }, { action: 'station', station: 'dubstep' },
      { action: 'volume', volumePercent: 42 }, { action: 'pause' }, { action: 'skip' },
      { action: 'volume', volumePercent: 101 }, { action: 'unsafe' },
    ],
  });
  assert.equal(cursor, 'generation:9');
  assert.deepEqual(calls, [['play'], ['station', 'dubstep'], ['volume', 42], ['pause'], ['skip']]);
});

test('poll sends bearer auth and opaque cursor without logging it', async () => {
  let receivedUrl;
  let receivedOptions;
  const packet = { cursor: 'g:3', reset: false, state: {}, events: [] };
  const result = await pollOnce({
    url: 'https://encoder.example/base', token: 't'.repeat(40), cursor: 'g:2',
    fetchImpl: async (url, options) => {
      receivedUrl = new URL(url);
      receivedOptions = options;
      return { ok: true, json: async () => packet };
    },
  });
  assert.equal(receivedUrl.pathname, '/api/encoder/commands');
  assert.equal(receivedUrl.searchParams.get('cursor'), 'g:2');
  assert.equal(receivedOptions.headers.Authorization, 'Bearer ' + 't'.repeat(40));
  assert.strictEqual(result, packet);
});

test('poll rejects unsuccessful or malformed responses', async () => {
  await assert.rejects(pollOnce({
    url: 'https://encoder.example', token: 't'.repeat(40),
    fetchImpl: async () => ({ ok: false, status: 401 }),
  }), /HTTP 401/);
  await assert.rejects(pollOnce({
    url: 'https://encoder.example', token: 't'.repeat(40),
    fetchImpl: async () => ({ ok: true, json: async () => ({ cursor: 3 }) }),
  }), /Invalid bridge response/);
});
