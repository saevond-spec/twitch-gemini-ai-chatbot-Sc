export function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

export function isExplicitClipCommand(message) {
  return /^!clip(?:\s|$)/i.test(String(message || '').trim());
}

export function isClipReaction(message) {
  return /\b(?:clip that|clip it|someone clip|that.?s a clip)\b/i.test(String(message || ''));
}

export function computeHighlightSignals({
  messageHistory = [],
  followEvents = [],
  now = Date.now(),
  windowMs = 20_000,
  historyMs = 180_000,
} = {}) {
  const history = (messageHistory || [])
    .filter(entry => Number.isFinite(Number(entry?.at)) && now - Number(entry.at) >= 0 && now - Number(entry.at) <= historyMs);

  const recent = history.filter(entry => now - Number(entry.at) <= windowMs);
  const baseline = history.filter(entry => {
    const age = now - Number(entry.at);
    return age > windowMs && age <= historyMs;
  });

  const recentSeconds = Math.max(1, windowMs / 1000);
  const baselineSeconds = Math.max(1, (historyMs - windowMs) / 1000);

  // Gamma-Poisson smoothing keeps a quiet stream from having a zero baseline
  // while still allowing a genuine burst to stand out quickly.
  const alpha = 1;
  const betaSeconds = 60;
  const baselineRate = (baseline.length + alpha) / (baselineSeconds + betaSeconds);
  const expectedRecent = Math.max(0.05, baselineRate * recentSeconds);
  const poissonZ = (recent.length - expectedRecent) / Math.sqrt(expectedRecent + 0.5);

  const uniqueUsers = new Set(recent.map(entry => String(entry.username || '').toLowerCase()).filter(Boolean)).size;
  const totalExcitement = recent.reduce((sum, entry) => sum + Math.max(0, Number(entry.excitement) || 0), 0);
  const explicitClipVoters = new Set(
    recent.filter(entry => isExplicitClipCommand(entry.message) || isClipReaction(entry.message))
      .map(entry => String(entry.username || '').toLowerCase())
      .filter(Boolean)
  ).size;
  const followCount = (followEvents || []).filter(at => Number.isFinite(Number(at)) && now - Number(at) >= 0 && now - Number(at) <= windowMs).length;

  const diversity = clamp(uniqueUsers / 3, 0, 1.5);
  const excitement = clamp(totalExcitement / 6, 0, 1.75);
  const clipVoteSignal = clamp(Math.log1p(explicitClipVoters), 0, 1.5);
  const followSignal = clamp(Math.log1p(followCount), 0, 1.25);
  const repeatRatio = recent.length ? Math.max(0, recent.length - uniqueUsers) / recent.length : 0;
  const spamPenalty = 2.2 * repeatRatio;

  // Logistic fusion. Rate anomaly gets the largest weight; independent viewers
  // and semantic excitement prevent a single spammer from creating a highlight.
  const linear = -3.4
    + 0.72 * clamp(poissonZ, -1, 5)
    + 1.05 * diversity
    + 0.85 * excitement
    + 1.6 * clipVoteSignal
    + 0.35 * followSignal
    - spamPenalty;

  const probability = sigmoid(linear);
  const score = Math.round(100 * probability);

  return {
    score,
    probability: Number(probability.toFixed(4)),
    poissonZ: Number(poissonZ.toFixed(2)),
    recentMessages: recent.length,
    baselineMessages: baseline.length,
    uniqueUsers,
    totalExcitement,
    explicitClipVoters,
    followCount,
    expectedRecent: Number(expectedRecent.toFixed(2)),
    spamPenalty: Number(spamPenalty.toFixed(2)),
  };
}

export function shouldEvaluateAutoClip(signals, threshold = 64) {
  if (!signals) return false;
  return Number(signals.score || 0) >= Number(threshold || 64);
}

export function shouldFallbackClipWithoutAI(signals, threshold = 84) {
  if (!signals) return false;
  return Number(signals.score || 0) >= Number(threshold || 84)
    && Number(signals.uniqueUsers || 0) >= 2;
}
