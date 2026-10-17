import { commercialEngagementScore, thompsonValue } from './math.js';
import {
  loadOfferCatalog,
  renderOffer,
  commercialIntent,
  commercialOptOut,
  messagePositive,
  messageNegative,
} from './catalog.js';
import { CommerceStore } from './store.js';

const DEFAULT_VIEWER_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_CHANNEL_COOLDOWN_MS = 15 * 60 * 1000;
const DEFAULT_CONVERSION_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

function contextFit(offer, message, explicitIntent) {
  const text = String(message || '').toLowerCase();
  const hits = offer.keywords.filter(keyword => text.includes(String(keyword).toLowerCase())).length;
  if (hits) return Math.min(1.6, 1 + 0.18 * hits);
  return explicitIntent ? 0.95 : 0.75;
}

export class CommerceEngine {
  constructor({
    enabled = process.env.SALES_ENGINE_ENABLED === 'true',
    catalog = loadOfferCatalog(),
    rng = Math.random,
    viewerCooldownMs = Number(process.env.SALES_VIEWER_COOLDOWN_DAYS || 30) * 24 * 60 * 60 * 1000,
    channelCooldownMs = Number(process.env.SALES_CHANNEL_COOLDOWN_MINUTES || 15) * 60 * 1000,
    conversionCooldownMs = Number(process.env.SALES_CONVERSION_COOLDOWN_DAYS || 30) * 24 * 60 * 60 * 1000,
  } = {}) {
    this.enabled = enabled;
    this.catalog = catalog;
    this.rng = rng;
    this.viewerCooldownMs = Number.isFinite(viewerCooldownMs) ? viewerCooldownMs : DEFAULT_VIEWER_COOLDOWN_MS;
    this.channelCooldownMs = Number.isFinite(channelCooldownMs) ? channelCooldownMs : DEFAULT_CHANNEL_COOLDOWN_MS;
    this.conversionCooldownMs = Number.isFinite(conversionCooldownMs) ? conversionCooldownMs : DEFAULT_CONVERSION_COOLDOWN_MS;
  }

  hasIntent(message) {
    return commercialIntent(message);
  }

  isOptOut(message) {
    return commercialOptOut(message);
  }

  async consider({
    channel,
    viewer,
    profile,
    message,
    directInteraction = false,
    proactiveWelcome = false,
    offerFollow = false,
    now = Date.now(),
  }) {
    if (!this.enabled) return { eligible: false, reason: 'disabled' };
    if (!profile || profile.proactiveOptOut || profile.commercialOptOut) return { eligible: false, reason: 'opt_out' };
    if (messageNegative(message)) return { eligible: false, reason: 'negative_context' };
    if (proactiveWelcome || offerFollow) return { eligible: false, reason: 'trust_priority' };

    const explicitIntent = commercialIntent(message);
    if (!explicitIntent && !directInteraction) return { eligible: false, reason: 'no_direct_engagement' };
    if (!explicitIntent && profile.messageCount < 5) return { eligible: false, reason: 'too_early' };
    if (!explicitIntent && profile.botInteractions < 2) return { eligible: false, reason: 'too_early' };

    const sessionAgeMs = profile.firstChatAt ? Math.max(0, now - profile.firstChatAt) : 0;
    if (!explicitIntent && sessionAgeMs < 180000) return { eligible: false, reason: 'too_early' };

    if (profile.lastCommercialPromptAt && now - profile.lastCommercialPromptAt < this.viewerCooldownMs) {
      return { eligible: false, reason: 'viewer_cooldown' };
    }
    if (profile.lastCommercialConversionAt && now - profile.lastCommercialConversionAt < this.conversionCooldownMs) {
      return { eligible: false, reason: 'post_conversion_cooldown' };
    }

    const lastChannelPrompt = await CommerceStore.getLastChannelPromptAt(channel);
    if (!explicitIntent && lastChannelPrompt && now - lastChannelPrompt < this.channelCooldownMs) {
      return { eligible: false, reason: 'channel_cooldown' };
    }

    const engagement = commercialEngagementScore({
      messageCount: profile.messageCount,
      botInteractions: profile.botInteractions,
      sessionAgeMs,
      positive: messagePositive(message),
      directInteraction,
      explicitIntent,
    });
    const threshold = explicitIntent ? 0.35 : 0.74;
    if (engagement < threshold) return { eligible: false, reason: 'low_engagement', engagement };

    const arms = [];
    for (const offer of this.catalog) {
      for (const variant of offer.variants) {
        const stats = await CommerceStore.getArmStats(offer.id, variant.id);
        const fatigue = Math.exp(-0.35 * Math.max(0, Number(profile.commercialPromptCount || 0)));
        const sample = thompsonValue({
          alpha: stats.alpha,
          beta: stats.beta,
          valueWeight: offer.valueWeight,
          contextFit: contextFit(offer, message, explicitIntent),
          fatigue,
          rng: this.rng,
        });
        arms.push({ offer, variant, stats, ...sample });
      }
    }
    if (!arms.length) return { eligible: false, reason: 'no_offers' };

    arms.sort((a, b) => b.score - a.score);
    const selected = arms[0];
    return {
      eligible: true,
      explicitIntent,
      engagement,
      offer: selected.offer,
      variant: selected.variant,
      banditScore: selected.score,
      conversionSample: selected.conversionSample,
      text: renderOffer(selected.offer, selected.variant),
    };
  }

  async recordImpression({ channel, viewer, selection, at = Date.now() }) {
    if (!selection?.eligible) return;
    await CommerceStore.recordImpression({
      channel,
      viewer,
      offerId: selection.offer.id,
      variantId: selection.variant.id,
      at,
    });
  }

  async recordConversion({ channel, viewer, expectedOfferId = null, value = 0, at = Date.now() }) {
    return CommerceStore.recordAttributedConversion({ channel, viewer, expectedOfferId, value, at });
  }

  async stats() {
    return CommerceStore.getAllStats(this.catalog);
  }
}
