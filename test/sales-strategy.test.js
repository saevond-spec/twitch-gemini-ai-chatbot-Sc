import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TWITCH_USERNAME ||= 'sweatyclanker';
process.env.TWITCH_CLIENT_ID ||= 'test-client';
process.env.TWITCH_CLIENT_SECRET ||= 'test-secret';
process.env.JOIN_CHANNELS ||= 'saevond';
process.env.DEEPSEEK_API_KEY ||= 'test-key';
process.env.REDIS_URL = '';

const { sampleBeta, posteriorFromCounts, thompsonValue } = await import('../src/commerce/math.js');
const { loadOfferCatalog, renderOffer, commercialOptOut } = await import('../src/commerce/catalog.js');
const { CommerceStore } = await import('../src/commerce/store.js');
const { CommerceEngine } = await import('../src/commerce/engine.js');

function seeded(seed = 0x51A35) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

test('Beta sampler stays bounded and posterior rewards conversions', () => {
  const rng = seeded();
  for (let i = 0; i < 1000; i += 1) {
    const x = sampleBeta(2, 8, rng);
    assert.ok(x >= 0 && x <= 1);
  }
  const before = posteriorFromCounts({ impressions: 100, conversions: 3 });
  const after = posteriorFromCounts({ impressions: 100, conversions: 10 });
  assert.ok(after.alpha > before.alpha);
  assert.ok(after.beta < before.beta);
});

test('catalog blocks prohibited categories and requires affiliate disclosure', () => {
  assert.throws(() => loadOfferCatalog({
    raw: JSON.stringify([{ id: 'bad', type: 'sponsor', category: 'gambling', url: 'https://example.com', disclosure: 'Paid' }]),
    brandedContentConfirmed: true,
  }), /blocked category/i);

  assert.throws(() => loadOfferCatalog({
    raw: JSON.stringify([{ id: 'affiliate1', type: 'affiliate', category: 'gaming', url: 'https://example.com' }]),
  }), /needs a clear disclosure/i);
});

test('sponsor offers require confirmation of Twitch branded-content disclosure', () => {
  const raw = JSON.stringify([{
    id: 'sponsor1',
    type: 'sponsor',
    category: 'gaming',
    title: 'Sponsored controller',
    url: 'https://example.com',
    disclosure: 'ControllerCo paid for this promotion.',
    variants: [{ id: 'a', text: 'ControllerCo controller' }],
  }]);
  assert.equal(loadOfferCatalog({ raw, brandedContentConfirmed: false }).some(x => x.id === 'sponsor1'), false);
  const catalog = loadOfferCatalog({ raw, brandedContentConfirmed: true });
  const offer = catalog.find(x => x.id === 'sponsor1');
  assert.ok(offer);
  assert.match(renderOffer(offer, offer.variants[0]), /^Paid promotion:/);
});

test('affiliate offers disclose commission in the same message', () => {
  const catalog = loadOfferCatalog({
    raw: JSON.stringify([{
      id: 'gear1',
      type: 'affiliate',
      category: 'gaming',
      title: 'Gaming headset',
      url: 'https://example.com/headset',
      disclosure: 'I may earn a commission.',
      variants: [{ id: 'a', text: 'This headset is the current gear link.' }],
    }]),
  });
  const offer = catalog.find(x => x.id === 'gear1');
  const text = renderOffer(offer, offer.variants[0]);
  assert.match(text, /may earn a commission/i);
  assert.match(text, /https:\/\/example\.com\/headset/);
});

test('commerce opt-out language is recognized', () => {
  assert.equal(commercialOptOut('no promos please'), true);
  assert.equal(commercialOptOut("don't sell to me"), true);
  assert.equal(commercialOptOut('that play was nice'), false);
});

test('engine never stacks sales with welcome or follow CTA', async () => {
  CommerceStore.clearMemoryForTests();
  const engine = new CommerceEngine({ enabled: true, rng: seeded() });
  const profile = {
    firstChatAt: 1,
    messageCount: 8,
    botInteractions: 4,
    followed: false,
    proactiveOptOut: false,
    commercialOptOut: false,
  };

  assert.equal((await engine.consider({
    channel: '#saevond', viewer: 'alice', profile, message: '@clanker nice fight',
    directInteraction: true, proactiveWelcome: true, offerFollow: false, now: 1_000_000,
  })).eligible, false);

  assert.equal((await engine.consider({
    channel: '#saevond', viewer: 'alice', profile, message: '@clanker nice fight',
    directInteraction: true, proactiveWelcome: false, offerFollow: true, now: 1_000_000,
  })).eligible, false);
});

test('explicit support intent gets a controlled offer while cold proactive selling does not', async () => {
  CommerceStore.clearMemoryForTests();
  const engine = new CommerceEngine({ enabled: true, rng: seeded() });
  const coldProfile = {
    firstChatAt: 1_000_000,
    messageCount: 1,
    botInteractions: 0,
    proactiveOptOut: false,
    commercialOptOut: false,
  };

  const cold = await engine.consider({
    channel: '#saevond', viewer: 'newviewer', profile: coldProfile,
    message: 'nice stream', directInteraction: false, now: 1_010_000,
  });
  assert.equal(cold.eligible, false);

  const intent = await engine.consider({
    channel: '#saevond', viewer: 'newviewer', profile: coldProfile,
    message: 'how can I support the stream?', directInteraction: true, now: 1_010_000,
  });
  assert.equal(intent.eligible, true);
  assert.match(intent.text, /support|sub|bits/i);
});

test('viewer cooldown and conversion cooldown suppress repeated selling', async () => {
  CommerceStore.clearMemoryForTests();
  const engine = new CommerceEngine({ enabled: true, rng: seeded() });
  const base = {
    firstChatAt: 1,
    messageCount: 10,
    botInteractions: 5,
    proactiveOptOut: false,
    commercialOptOut: false,
  };

  const viewerCooldown = await engine.consider({
    channel: '#saevond', viewer: 'alice',
    profile: { ...base, lastCommercialPromptAt: 900_000 },
    message: '@clanker nice clutch', directInteraction: true, now: 1_000_000,
  });
  assert.equal(viewerCooldown.reason, 'viewer_cooldown');

  const conversionCooldown = await engine.consider({
    channel: '#saevond', viewer: 'bob',
    profile: { ...base, lastCommercialConversionAt: 900_000 },
    message: '@clanker nice clutch', directInteraction: true, now: 1_000_000,
  });
  assert.equal(conversionCooldown.reason, 'post_conversion_cooldown');
});

test('only attributed conversions train the selected arm', async () => {
  CommerceStore.clearMemoryForTests();
  const selection = {
    eligible: true,
    offer: { id: 'twitch_sub' },
    variant: { id: 'value' },
  };
  const engine = new CommerceEngine({ enabled: true, rng: seeded() });

  await engine.recordImpression({ channel: '#saevond', viewer: 'alice', selection, at: 10_000 });
  const before = await CommerceStore.getArmStats('twitch_sub', 'value');
  assert.equal(before.impressions, 1);
  assert.equal(before.conversions, 0);

  const wrong = await engine.recordConversion({
    channel: '#saevond', viewer: 'alice', expectedOfferId: 'twitch_bits', at: 20_000,
  });
  assert.equal(wrong.attributed, false);

  const right = await engine.recordConversion({
    channel: '#saevond', viewer: 'alice', expectedOfferId: 'twitch_sub', at: 20_000,
  });
  assert.equal(right.attributed, true);
  const after = await CommerceStore.getArmStats('twitch_sub', 'value');
  assert.equal(after.impressions, 1);
  assert.equal(after.conversions, 1);
});

test('five-year Thompson simulation learns the higher-converting strategy with bounded regret', () => {
  const rng = seeded(0xB4A7);
  const arms = [
    { id: 'value', trueRate: 0.035, impressions: 0, conversions: 0 },
    { id: 'community', trueRate: 0.065, impressions: 0, conversions: 0 },
  ];
  const totalTrials = 1826 * 20;
  let optimalSelectionsLast5000 = 0;
  let regret = 0;

  for (let i = 0; i < totalTrials; i += 1) {
    const scored = arms.map(arm => {
      const posterior = posteriorFromCounts(arm);
      return { arm, ...thompsonValue({ ...posterior, valueWeight: 1, contextFit: 1, fatigue: 1, rng }) };
    }).sort((a, b) => b.score - a.score);

    const chosen = scored[0].arm;
    chosen.impressions += 1;
    if (rng() < chosen.trueRate) chosen.conversions += 1;
    regret += 0.065 - chosen.trueRate;
    if (i >= totalTrials - 5000 && chosen.id === 'community') optimalSelectionsLast5000 += 1;
  }

  assert.ok(optimalSelectionsLast5000 / 5000 > 0.9, 'bandit should strongly prefer the better arm late in the horizon');
  assert.ok(regret / totalTrials < 0.006, 'average conversion regret should remain bounded');
});
