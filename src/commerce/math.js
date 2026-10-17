export function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function sampleStandardNormal(rng) {
  const u1 = Math.max(Number.EPSILON, rng());
  const u2 = Math.max(Number.EPSILON, rng());
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export function sampleGamma(shape, rng = Math.random) {
  if (!(shape > 0)) throw new Error('Gamma shape must be > 0');
  if (shape < 1) {
    const u = Math.max(Number.EPSILON, rng());
    return sampleGamma(shape + 1, rng) * Math.pow(u, 1 / shape);
  }

  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = sampleStandardNormal(rng);
    const v0 = 1 + c * x;
    if (v0 <= 0) continue;
    const v = v0 * v0 * v0;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(Math.max(Number.EPSILON, u)) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function sampleBeta(alpha, beta, rng = Math.random) {
  if (!(alpha > 0) || !(beta > 0)) throw new Error('Beta parameters must be > 0');
  const x = sampleGamma(alpha, rng);
  const y = sampleGamma(beta, rng);
  return x / (x + y);
}

export function posteriorFromCounts({ impressions = 0, conversions = 0, alpha0 = 1, beta0 = 19 } = {}) {
  const safeImpressions = Math.max(0, Number(impressions) || 0);
  const safeConversions = Math.max(0, Math.min(safeImpressions, Number(conversions) || 0));
  return {
    alpha: alpha0 + safeConversions,
    beta: beta0 + safeImpressions - safeConversions,
  };
}

export function commercialEngagementScore({
  messageCount = 0,
  botInteractions = 0,
  sessionAgeMs = 0,
  positive = false,
  directInteraction = false,
  explicitIntent = false,
} = {}) {
  const linear = -4.1
    + 0.34 * Math.min(10, Math.max(0, messageCount))
    + 0.48 * Math.min(6, Math.max(0, botInteractions))
    + 0.55 * Math.min(4, Math.max(0, sessionAgeMs / 120000))
    + (positive ? 0.8 : 0)
    + (directInteraction ? 1.0 : 0)
    + (explicitIntent ? 2.8 : 0);
  return sigmoid(linear);
}

export function thompsonValue({
  alpha,
  beta,
  valueWeight = 1,
  contextFit = 1,
  fatigue = 1,
  rng = Math.random,
}) {
  const conversionSample = sampleBeta(alpha, beta, rng);
  return {
    conversionSample,
    score: conversionSample
      * Math.max(0.05, Number(valueWeight) || 1)
      * Math.max(0.1, Number(contextFit) || 1)
      * Math.max(0.05, Number(fatigue) || 1),
  };
}
