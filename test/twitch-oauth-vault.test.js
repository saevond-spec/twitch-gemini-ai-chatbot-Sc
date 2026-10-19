import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TWITCH_USERNAME ||= 'sweatyclanker';
process.env.TWITCH_CLIENT_ID ||= 'test-client';
process.env.TWITCH_CLIENT_SECRET ||= 'test-client-secret-with-enough-entropy';
process.env.JOIN_CHANNELS ||= 'saevond';
process.env.DEEPSEEK_API_KEY ||= 'test-key';
process.env.REDIS_URL = '';

const {
  chooseFreshestToken,
  decryptTokenRecord,
  encryptTokenRecord,
  makeGeneration,
} = await import('../src/twitch/tokenVault.js');

function token(generation, suffix = String(generation), updatedAt = generation) {
  return {
    access_token: 'access-' + suffix,
    refresh_token: 'refresh-' + suffix,
    expires_in: 14400,
    expires_at: updatedAt + 14_400_000,
    login: 'sweatyclanker',
    user_id: '1524040103',
    scopes: ['chat:read', 'chat:edit'],
    vault_generation: generation,
    vault_updated_at: updatedAt,
  };
}

test('OAuth vault encryption round-trips and never exposes raw token text', () => {
  const original = token(1234, 'super-secret', 50_000);
  const encrypted = encryptTokenRecord(original);

  assert.match(encrypted, /^v1\./);
  assert.doesNotMatch(encrypted, /access-super-secret|refresh-super-secret/);
  assert.deepEqual(decryptTokenRecord(encrypted), original);
});

test('freshest OAuth generation wins regardless of storage source', () => {
  const best = chooseFreshestToken([
    { source: 'file', token: token(10, 'file', 10_000) },
    { source: 'postgres', token: token(12, 'pg', 12_000) },
    { source: 'redis', token: token(11, 'redis', 11_000) },
  ]);

  assert.equal(best.access_token, 'access-pg');
  assert.equal(best.refresh_token, 'refresh-pg');
  assert.equal(best.vault_generation, 12);
  assert.equal(best.vault_source, 'postgres');
});

test('timestamp breaks ties between equal generations', () => {
  const best = chooseFreshestToken([
    { source: 'postgres', token: token(20, 'old', 20_000) },
    { source: 'redis', token: token(20, 'new', 25_000) },
  ]);
  assert.equal(best.access_token, 'access-new');
});

test('legacy token records remain loadable as generation zero', () => {
  const best = chooseFreshestToken([{
    source: 'file',
    token: {
      access_token: 'legacy-access',
      refresh_token: 'legacy-refresh',
      expires_at: 12345,
    },
  }]);
  assert.equal(best.vault_generation, 0);
  assert.equal(best.access_token, 'legacy-access');
});

test('generation IDs are monotonic even at the same millisecond', () => {
  const first = makeGeneration(0, 1_700_000_000_000, 100);
  const second = makeGeneration(first, 1_700_000_000_000, 10);
  assert.ok(second > first);
});

test('two-year worst-case rotation simulation survives redeploys and single-store outages', () => {
  const days = 730;
  const refreshesPerDay = 6; // conservative 4-hour access-token cycle
  const totalRefreshes = days * refreshesPerDay;

  let generation = makeGeneration(0, 1_700_000_000_000, 1);
  let live = token(generation, '0', 1_700_000_000_000);
  let postgres = structuredClone(live);
  let redis = structuredClone(live);
  let file = structuredClone(live);

  let redeploys = 0;
  let refreshRacesRecovered = 0;
  let postgresOutageRefreshes = 0;
  let redisOutageRefreshes = 0;
  let staleCopiesRejected = 0;

  function pgDown(day) {
    return (day >= 120 && day < 123)
      || (day >= 365 && day < 367)
      || (day >= 600 && day < 601);
  }

  function redisDown(day) {
    return (day >= 35 && day < 80)
      || (day >= 300 && day < 350)
      || (day >= 500 && day < 540);
  }

  for (let i = 1; i <= totalRefreshes; i += 1) {
    const day = Math.floor((i - 1) / refreshesPerDay);
    const now = 1_700_000_000_000 + i * 4 * 60 * 60 * 1000;

    // Worst-case Twitch behavior: every successful refresh rotates the refresh token.
    generation = makeGeneration(generation, now, i % 1000);
    live = token(generation, String(i), now);
    file = structuredClone(live);

    if (!pgDown(day)) postgres = structuredClone(live);
    else postgresOutageRefreshes += 1;

    if (!redisDown(day)) redis = structuredClone(live);
    else redisOutageRefreshes += 1;

    // When either durable/cache backend recovers, read-repair it with the freshest generation.
    if (!pgDown(day)) {
      const freshest = chooseFreshestToken([
        postgres && { source: 'postgres', token: postgres },
        redis && { source: 'redis', token: redis },
        file && { source: 'file', token: file },
      ]);
      if (freshest && Number(postgres?.vault_generation || 0) < freshest.vault_generation) {
        postgres = structuredClone(freshest);
      }
    }
    if (!redisDown(day)) {
      const freshest = chooseFreshestToken([
        postgres && { source: 'postgres', token: postgres },
        redis && { source: 'redis', token: redis },
        file && { source: 'file', token: file },
      ]);
      if (freshest && Number(redis?.vault_generation || 0) < freshest.vault_generation) {
        redis = structuredClone(freshest);
      }
    }

    // Simulate a multi-instance refresh race every 73 refreshes. Another instance
    // wins with a strictly newer generation; this instance must recover it rather
    // than asking for OAuth.
    if (i % 73 === 0 && !pgDown(day)) {
      const winnerGeneration = makeGeneration(generation, now + 1, 999);
      const winner = token(winnerGeneration, 'race-' + i, now + 1);
      postgres = structuredClone(winner);
      if (!redisDown(day)) redis = structuredClone(winner);

      const recovered = chooseFreshestToken([
        { source: 'postgres', token: postgres },
        redis && { source: 'redis', token: redis },
        { source: 'file', token: file },
      ].filter(Boolean));
      assert.equal(recovered.vault_generation, winnerGeneration);
      live = structuredClone(recovered);
      generation = winnerGeneration;
      file = structuredClone(recovered);
      refreshRacesRecovered += 1;
    }

    // Force frequent instance replacement. Local file disappears every time.
    if (i % 12 === 0 || i % 97 === 0) {
      redeploys += 1;
      file = null;
      const recovered = chooseFreshestToken([
        postgres && { source: 'postgres', token: postgres },
        redis && { source: 'redis', token: redis },
      ].filter(Boolean));

      assert.ok(recovered, `authorization lost at refresh ${i}, day ${day}`);
      if (recovered.vault_generation < generation) staleCopiesRejected += 1;
      assert.ok(recovered.vault_generation >= generation, `stale OAuth generation restored at refresh ${i}`);
      live = structuredClone(recovered);
      generation = recovered.vault_generation;
      file = structuredClone(recovered);
    }
  }

  assert.equal(generation, live.vault_generation);
  assert.ok(redeploys > 350);
  assert.ok(refreshRacesRecovered > 50);
  assert.ok(postgresOutageRefreshes > 0);
  assert.ok(redisOutageRefreshes > 0);

  console.log('TWITCH_OAUTH_TWO_YEAR_SIMULATION=' + JSON.stringify({
    days,
    totalRefreshes,
    redeploys,
    refreshRacesRecovered,
    postgresOutageRefreshes,
    redisOutageRefreshes,
    staleCopiesRejected,
    authorizationLosses: 0,
    worstCaseRefreshTokenRotationRate: 1,
  }));
});

test('failure boundary is explicit: losing all durable copies cannot be solved by code', () => {
  const recovered = chooseFreshestToken([]);
  assert.equal(recovered, null);
});
