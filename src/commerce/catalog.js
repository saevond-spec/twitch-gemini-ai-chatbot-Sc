const BLOCKED_CATEGORIES = new Set([
  'alcohol', 'adult', 'adult-content', 'cannabis', 'crypto-ico', 'firearms', 'gambling',
  'get-rich-quick', 'hacking', 'malware', 'mlm', 'payday-loans', 'political',
  'prescription-drugs', 'tobacco', 'weapons'
]);

const DEFAULT_OFFERS = [
  {
    id: 'twitch_sub',
    type: 'twitch-native',
    category: 'creator-support',
    title: 'Twitch subscription',
    objective: 'support',
    valueWeight: 1.0,
    keywords: ['sub', 'subscribe', 'subscription', 'emote', 'emotes', 'badge', 'support'],
    variants: [
      { id: 'value', text: 'If you want to support the stream, a sub unlocks the channel emotes and badge — totally optional.' },
      { id: 'community', text: 'Enjoying the stream? Subbing is an optional way to support it and unlock the channel perks.' },
    ],
  },
  {
    id: 'twitch_bits',
    type: 'twitch-native',
    category: 'creator-support',
    title: 'Twitch Bits',
    objective: 'support',
    valueWeight: 0.85,
    keywords: ['bits', 'cheer', 'cheering', 'support', 'hype'],
    variants: [
      { id: 'moment', text: 'If a moment deserves extra hype, Bits are an optional way to support the stream.' },
      { id: 'simple', text: 'If you ever want to support with Bits, they’re there — no pressure.' },
    ],
  },
];

function parseConfiguredOffers(raw) {
  if (!raw) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('SALES_OFFERS_JSON must be valid JSON'); }
  if (!Array.isArray(parsed)) throw new Error('SALES_OFFERS_JSON must be a JSON array');
  return parsed;
}

function normalizeOffer(offer) {
  const normalized = {
    id: String(offer.id || '').trim(),
    type: String(offer.type || 'self').trim().toLowerCase(),
    category: String(offer.category || 'general').trim().toLowerCase(),
    title: String(offer.title || offer.id || '').trim(),
    url: offer.url ? String(offer.url).trim() : null,
    objective: String(offer.objective || 'sale').trim().toLowerCase(),
    valueWeight: Math.max(0.05, Number(offer.valueWeight || 1)),
    disclosure: offer.disclosure ? String(offer.disclosure).trim() : '',
    keywords: Array.isArray(offer.keywords) ? offer.keywords.map(String) : [],
    variants: Array.isArray(offer.variants) ? offer.variants : [],
  };

  if (!normalized.id || !/^[a-z0-9_-]{2,64}$/i.test(normalized.id)) {
    throw new Error('Every sales offer needs a safe id');
  }
  if (BLOCKED_CATEGORIES.has(normalized.category)) {
    throw new Error(`Offer ${normalized.id} uses blocked category ${normalized.category}`);
  }
  if (!['twitch-native', 'self', 'affiliate', 'sponsor'].includes(normalized.type)) {
    throw new Error(`Offer ${normalized.id} has unsupported type ${normalized.type}`);
  }
  if (normalized.type === 'affiliate' && !normalized.disclosure) {
    throw new Error(`Affiliate offer ${normalized.id} needs a clear disclosure`);
  }
  if (normalized.type === 'sponsor' && !normalized.disclosure) {
    throw new Error(`Sponsor offer ${normalized.id} needs a clear disclosure`);
  }
  if (normalized.type !== 'twitch-native' && !normalized.url) {
    throw new Error(`Offer ${normalized.id} needs a URL`);
  }
  if (!normalized.variants.length) {
    normalized.variants = [{ id: 'default', text: normalized.title }];
  }
  normalized.variants = normalized.variants.map((variant, index) => ({
    id: String(variant.id || `v${index + 1}`).replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || `v${index + 1}`,
    text: String(variant.text || normalized.title).trim().slice(0, 320),
  }));
  return normalized;
}

export function loadOfferCatalog({
  raw = process.env.SALES_OFFERS_JSON || '',
  brandedContentConfirmed = process.env.BRANDED_CONTENT_DISCLOSURE_CONFIRMED === 'true',
} = {}) {
  const custom = parseConfiguredOffers(raw).map(normalizeOffer);
  return [...DEFAULT_OFFERS.map(normalizeOffer), ...custom]
    .filter(offer => offer.type !== 'sponsor' || brandedContentConfirmed);
}

export function renderOffer(offer, variant) {
  const base = variant?.text || offer.title;
  if (offer.type === 'affiliate') {
    return `Affiliate disclosure: I may earn a commission if you buy through this link. ${base} ${offer.url}`;
  }
  if (offer.type === 'sponsor') {
    return `Paid promotion: ${offer.disclosure} ${base} ${offer.url}`;
  }
  if (offer.type === 'self') {
    return `${base} ${offer.url}`;
  }
  return base;
}

export function commercialIntent(message) {
  const text = String(message || '').toLowerCase();
  return /\b(how (do|can) i support|support (the )?stream|where (can|do) i (buy|get)|merch|shop|store|affiliate|sponsor|sponsored|sub(scribe|scription)?|bits|cheer|donate|tip)\b/i.test(text);
}

export function commercialOptOut(message) {
  return /\b(no promos?|stop promos?|no ads?|stop ads?|no sales|stop selling|don't sell to me|dont sell to me)\b/i.test(String(message || ''));
}

export function messagePositive(message) {
  return /\b(lol|lmao|haha|gg|nice|love|fun|funny|cool|awesome|great|good|clutch|insane|crazy|wow|thanks|fire|goated|w)\b/i.test(String(message || ''));
}

export function messageNegative(message) {
  return /\b(boring|annoying|hate|bad bot|shut up|leave me alone|stop bot|scam|ripoff|rip-off)\b/i.test(String(message || ''));
}
