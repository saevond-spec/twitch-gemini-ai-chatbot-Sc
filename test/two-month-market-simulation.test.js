import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TWITCH_USERNAME ||= 'sweatyclanker';
process.env.TWITCH_CLIENT_ID ||= 'test-client';
process.env.TWITCH_CLIENT_SECRET ||= 'test-secret';
process.env.JOIN_CHANNELS ||= 'saevond';
process.env.DEEPSEEK_API_KEY ||= 'test-key';
process.env.REDIS_URL = '';

const { CommerceEngine } = await import('../src/commerce/engine.js');
const { CommerceStore } = await import('../src/commerce/store.js');
const { loadOfferCatalog } = await import('../src/commerce/catalog.js');

const DAY = 24 * 60 * 60 * 1000;
const START = Date.UTC(2026, 9, 17);
const END = Date.UTC(2026, 11, 17);
const HORIZON_DAYS = (END - START) / DAY;

// Current market stress inputs from Adobe/NRF research are used only to scale
// scenario volume, not as Twitch conversion-rate claims.
const MARKET = Object.freeze({
  octoberOnlineYoYGrowth: 0.08,
  holidayOnlineYoYGrowth: 0.067,
  holidayRetailYoYGrowth: 0.042,
  socialRevenueShareGrowth: 0.17,
  affiliateRevenueShareGrowth: 0.12,
  cyberWeekHolidaySpendShare: 0.173,
  holidayCalendarDays: 61, // Nov 1-Dec 31
  cyberWeekDays: 5,
});
const CYBER_WEEK_CONCENTRATION =
  MARKET.cyberWeekHolidaySpendShare / (MARKET.cyberWeekDays / MARKET.holidayCalendarDays);

function seeded(seed = 0x2BADC0DE) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function marketVolumeMultiplier(now) {
  const date = isoDay(now);
  if (date >= '2026-11-26' && date <= '2026-11-30') {
    return (1 + MARKET.holidayOnlineYoYGrowth) * CYBER_WEEK_CONCENTRATION;
  }
  if (date >= '2026-11-01') return 1 + MARKET.holidayOnlineYoYGrowth;
  return 1 + MARKET.octoberOnlineYoYGrowth;
}

function baseProfile(now) {
  return {
    firstChatAt: now - 12 * 60 * 1000,
    messageCount: 8,
    botInteractions: 4,
    proactiveOptOut: false,
    commercialOptOut: false,
    lastCommercialPromptAt: null,
    lastCommercialConversionAt: null,
    commercialPromptCount: 0,
  };
}

test('two-month horizon spans 61 elapsed days and includes Cyber Week', () => {
  assert.equal(HORIZON_DAYS, 61);
  assert.ok(CYBER_WEEK_CONCENTRATION > 2 && CYBER_WEEK_CONCENTRATION < 2.2);
});

test('current holiday market inputs increase stress volume without becoming Twitch conversion claims', () => {
  assert.equal(marketVolumeMultiplier(Date.UTC(2026, 9, 20)), 1.08);
  assert.equal(marketVolumeMultiplier(Date.UTC(2026, 10, 10)), 1.067);
  assert.ok(marketVolumeMultiplier(Date.UTC(2026, 10, 27)) > 2.2);
  assert.equal(MARKET.socialRevenueShareGrowth, 0.17);
  assert.equal(MARKET.affiliateRevenueShareGrowth, 0.12);
});

test('real-world guardrails: first chat, follow CTA, negative context, and opt-out never stack with sales', async () => {
  CommerceStore.clearMemoryForTests();
  const engine = new CommerceEngine({ enabled: true, rng: seeded() });
  const now = START + DAY;

  const cases = [
    {
      name: 'first-chat welcome',
      profile: { ...baseProfile(now), messageCount: 1, botInteractions: 0 },
      message: 'hey first time here',
      directInteraction: true,
      proactiveWelcome: true,
      offerFollow: false,
      reason: 'trust_priority',
    },
    {
      name: 'follow CTA',
      profile: baseProfile(now),
      message: '@clanker this is fun',
      directInteraction: true,
      proactiveWelcome: false,
      offerFollow: true,
      reason: 'trust_priority',
    },
    {
      name: 'negative context',
      profile: baseProfile(now),
      message: '@clanker this bot is annoying',
      directInteraction: true,
      proactiveWelcome: false,
      offerFollow: false,
      reason: 'negative_context',
    },
    {
      name: 'commercial opt-out',
      profile: { ...baseProfile(now), commercialOptOut: true },
      message: '@clanker nice stream',
      directInteraction: true,
      proactiveWelcome: false,
      offerFollow: false,
      reason: 'opt_out',
    },
  ];

  for (const scenario of cases) {
    const result = await engine.consider({
      channel: '#saevond',
      viewer: scenario.name.replace(/\s+/g, '-'),
      profile: scenario.profile,
      message: scenario.message,
      directInteraction: scenario.directInteraction,
      proactiveWelcome: scenario.proactiveWelcome,
      offerFollow: scenario.offerFollow,
      now,
    });
    assert.equal(result.eligible, false, scenario.name);
    assert.equal(result.reason, scenario.reason, scenario.name);
  }
});

test('explicit support intent can be answered while cold unsolicited selling stays off', async () => {
  CommerceStore.clearMemoryForTests();
  const engine = new CommerceEngine({ enabled: true, rng: seeded() });
  const now = START + 2 * DAY;

  const cold = await engine.consider({
    channel: '#saevond',
    viewer: 'cold-viewer',
    profile: { ...baseProfile(now), messageCount: 1, botInteractions: 0, firstChatAt: now },
    message: 'nice gameplay',
    directInteraction: false,
    now,
  });
  assert.equal(cold.eligible, false);

  const intent = await engine.consider({
    channel: '#saevond',
    viewer: 'support-viewer',
    profile: { ...baseProfile(now), messageCount: 1, botInteractions: 0, firstChatAt: now },
    message: 'how can I support the stream?',
    directInteraction: true,
    now,
  });
  assert.equal(intent.eligible, true);
  assert.match(intent.text, /support|sub|bits/i);
});

test('attribution distinguishes CTA-influenced support from organic support', async () => {
  CommerceStore.clearMemoryForTests();
  const engine = new CommerceEngine({ enabled: true, rng: seeded() });
  const now = START + 3 * DAY;

  const selection = await engine.consider({
    channel: '#saevond',
    viewer: 'alice',
    profile: baseProfile(now),
    message: 'how can I support the stream?',
    directInteraction: true,
    now,
  });
  assert.equal(selection.eligible, true);

  await engine.recordImpression({ channel: '#saevond', viewer: 'alice', selection, at: now });
  const attributed = await engine.recordConversion({
    channel: '#saevond',
    viewer: 'alice',
    expectedOfferId: selection.offer.id,
    at: now + 10 * 60 * 1000,
  });
  assert.equal(attributed.attributed, true);

  const organic = await engine.recordConversion({
    channel: '#saevond',
    viewer: 'bob',
    expectedOfferId: 'twitch_sub',
    at: now + 10 * 60 * 1000,
  });
  assert.equal(organic.attributed, false);
  assert.equal(organic.reason, 'no_attribution');
});

test('24-hour attribution window rejects late conversions', async () => {
  CommerceStore.clearMemoryForTests();
  const engine = new CommerceEngine({ enabled: true, rng: seeded() });
  const now = START + 4 * DAY;

  const selection = {
    eligible: true,
    offer: { id: 'twitch_sub' },
    variant: { id: 'value' },
  };
  await engine.recordImpression({ channel: '#saevond', viewer: 'late-viewer', selection, at: now });
  const late = await engine.recordConversion({
    channel: '#saevond',
    viewer: 'late-viewer',
    expectedOfferId: 'twitch_sub',
    at: now + 25 * 60 * 60 * 1000,
  });
  assert.equal(late.attributed, false);
  assert.equal(late.reason, 'no_attribution');
});

test('affiliate and sponsor rules remain compliant under holiday campaign configuration', () => {
  const affiliateRaw = JSON.stringify([{
    id: 'controller_affiliate',
    type: 'affiliate',
    category: 'gaming',
    title: 'Controller gear',
    url: 'https://example.com/controller',
    disclosure: 'I may earn a commission.',
    valueWeight: 1.1,
    keywords: ['controller', 'gear'],
    variants: [{ id: 'value', text: 'If you asked about the controller, this is the gear link.' }],
  }]);

  const affiliateCatalog = loadOfferCatalog({ raw: affiliateRaw, brandedContentConfirmed: false });
  assert.ok(affiliateCatalog.some(offer => offer.id === 'controller_affiliate'));

  const sponsorRaw = JSON.stringify([{
    id: 'sponsor_controller',
    type: 'sponsor',
    category: 'gaming',
    title: 'Sponsored controller',
    url: 'https://example.com/sponsor-controller',
    disclosure: 'ControllerCo paid for this promotion.',
    variants: [{ id: 'a', text: 'ControllerCo controller' }],
  }]);
  assert.equal(
    loadOfferCatalog({ raw: sponsorRaw, brandedContentConfirmed: false })
      .some(offer => offer.id === 'sponsor_controller'),
    false,
  );
  assert.equal(
    loadOfferCatalog({ raw: sponsorRaw, brandedContentConfirmed: true })
      .some(offer => offer.id === 'sponsor_controller'),
    true,
  );
});

test('61-day market-stressed simulation keeps trust controls intact through Cyber Week', async () => {
  CommerceStore.clearMemoryForTests();
  const random = seeded(0x61DA7A);
  const engine = new CommerceEngine({
    enabled: true,
    rng: random,
    channelCooldownMs: 15 * 60 * 1000,
    viewerCooldownMs: 30 * DAY,
    conversionCooldownMs: 30 * DAY,
  });

  const viewers = new Map();
  const summary = {
    days: HORIZON_DAYS,
    simulatedViewerSessions: 0,
    explicitIntentSessions: 0,
    eligiblePrompts: 0,
    conversions: 0,
    optOuts: 0,
    coldSales: 0,
    repeatPromptsInside30Days: 0,
    postConversionPromptsInside30Days: 0,
    cyberWeekPrompts: 0,
    ordinaryWeekPrompts: 0,
    attributionMisses: 0,
  };

  let viewerCounter = 0;
  for (let day = 0; day < HORIZON_DAYS; day += 1) {
    const dayStart = START + day * DAY;
    const date = isoDay(dayStart);
    const volumeMultiplier = marketVolumeMultiplier(dayStart);

    // Baseline stream audience volume is synthetic. Market research only scales
    // the stress load; it does not supply Twitch-specific conversion rates.
    const sessionsToday = Math.round(55 * volumeMultiplier);
    for (let i = 0; i < sessionsToday; i += 1) {
      let viewer;
      if (viewers.size && random() < 0.34) {
        const keys = [...viewers.keys()];
        viewer = keys[Math.floor(random() * keys.length)];
      } else {
        viewer = `viewer-${viewerCounter++}`;
      }

      const profile = viewers.get(viewer) || baseProfile(dayStart);
      summary.simulatedViewerSessions += 1;

      // Synthetic behavior assumptions chosen for stress testing only.
      const explicitIntent = random() < 0.045 * Math.min(1.4, volumeMultiplier);
      const negative = random() < 0.025;
      const optsOut = !profile.commercialOptOut && random() < 0.003;
      const directInteraction = explicitIntent || random() < 0.58;
      const message = optsOut
        ? 'no promos please'
        : negative
          ? '@clanker this is annoying'
          : explicitIntent
            ? (random() < 0.65 ? 'how can I support the stream?' : 'where can I sub?')
            : (directInteraction ? '@clanker nice clutch lol' : 'nice clutch');

      if (optsOut) {
        profile.commercialOptOut = true;
        summary.optOuts += 1;
      }
      if (explicitIntent) summary.explicitIntentSessions += 1;

      const result = await engine.consider({
        channel: '#saevond',
        viewer,
        profile,
        message,
        directInteraction,
        proactiveWelcome: false,
        offerFollow: false,
        now: dayStart + i * 20_000,
      });

      if (result.eligible) {
        if (!directInteraction && !explicitIntent) summary.coldSales += 1;

        const lastPrompt = profile.lastCommercialPromptAt;
        if (lastPrompt && dayStart - lastPrompt < 30 * DAY) summary.repeatPromptsInside30Days += 1;
        if (profile.lastCommercialConversionAt && dayStart - profile.lastCommercialConversionAt < 30 * DAY) {
          summary.postConversionPromptsInside30Days += 1;
        }

        await engine.recordImpression({
          channel: '#saevond',
          viewer,
          selection: result,
          at: dayStart + i * 20_000,
        });
        profile.lastCommercialPromptAt = dayStart + i * 20_000;
        profile.commercialPromptCount = Number(profile.commercialPromptCount || 0) + 1;
        summary.eligiblePrompts += 1;
        if (date >= '2026-11-26' && date <= '2026-11-30') summary.cyberWeekPrompts += 1;
        else summary.ordinaryWeekPrompts += 1;

        // Synthetic conversion propensity; this is intentionally not presented
        // as market data. Explicit intent has a higher rate than ambient engagement.
        const syntheticRate = explicitIntent ? 0.16 : 0.045;
        if (random() < syntheticRate) {
          const conversion = await engine.recordConversion({
            channel: '#saevond',
            viewer,
            expectedOfferId: result.offer.id,
            at: dayStart + i * 20_000 + 8 * 60 * 1000,
          });
          if (conversion.attributed) {
            summary.conversions += 1;
            profile.lastCommercialConversionAt = dayStart + i * 20_000 + 8 * 60 * 1000;
          } else {
            summary.attributionMisses += 1;
          }
        }
      }

      viewers.set(viewer, profile);
    }
  }

  assert.equal(summary.coldSales, 0, 'commercial CTAs must never appear without direct engagement or explicit intent');
  assert.equal(summary.repeatPromptsInside30Days, 0, 'viewer cooldown must prevent repeat prompts inside 30 days');
  assert.equal(summary.postConversionPromptsInside30Days, 0, 'post-conversion cooldown must hold');
  assert.equal(summary.attributionMisses, 0, 'in-window simulated conversions should attribute cleanly');
  assert.ok(summary.simulatedViewerSessions > 3500);
  assert.ok(summary.explicitIntentSessions > 100);
  assert.ok(summary.eligiblePrompts > 20);
  assert.ok(summary.cyberWeekPrompts > 0, 'Cyber Week stress window should exercise commercial flow');

  console.log('TWO_MONTH_MARKET_SIMULATION=' + JSON.stringify({
    ...summary,
    marketInputs: MARKET,
    cyberWeekConcentration: Number(CYBER_WEEK_CONCENTRATION.toFixed(3)),
  }));
});
