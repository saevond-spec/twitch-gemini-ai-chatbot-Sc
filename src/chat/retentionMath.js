import { sampleBeta } from '../commerce/math.js';

export function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

const POSITIVE = /\b(lol|lmao|haha|gg|nice|love|fun|funny|cool|awesome|great|good|clutch|insane|crazy|wow|thanks|fire|goated|clean|w)\b/i;
const NEGATIVE = /\b(boring|annoying|hate|bad bot|shut up|leave me alone|stop bot|no bot|bot off)\b/i;
const TACTICAL = /\b(parry|clutch|rotate|position|timing|angle|flank|push|heal|reload|dodge|counter|punish|combo|ult|ability|peek|cover|extract|revive|fight|weapon|build|strategy|play)\b/i;
const PREDICTIVE = /\b(next|think|bet|predict|prediction|win|lose|push|fight|round|match|extract|boss|weapon|loadout)\b/i;

export function retentionOpportunityScore({
  messageCount = 0,
  botInteractions = 0,
  sessionAgeMs = 0,
  recentHumanTurns = 0,
  recentBotQuestions = 0,
  responseLatencyMs = null,
  directInteraction = false,
  message = '',
  proactiveOptOut = false,
} = {}) {
  if (proactiveOptOut || !directInteraction || NEGATIVE.test(String(message || ''))) return 0;

  const positive = POSITIVE.test(String(message || '')) ? 1 : 0;
  const latencyMinutes = responseLatencyMs == null
    ? 1
    : Math.min(6, Math.max(0, Number(responseLatencyMs) / 60_000));

  const linear = -2.8
    + 0.34 * Math.min(8, Math.max(0, Number(messageCount) || 0))
    + 0.28 * Math.min(6, Math.max(0, Number(botInteractions) || 0))
    + 0.42 * Math.min(4, Math.max(0, Number(recentHumanTurns) || 0))
    + 0.28 * Math.min(4, Math.max(0, Number(sessionAgeMs) || 0) / 120_000)
    + 0.65 * positive
    + 0.75
    - 0.65 * Math.min(3, Math.max(0, Number(recentBotQuestions) || 0))
    - 0.12 * latencyMinutes;

  return Math.max(0, Math.min(1, sigmoid(linear)));
}

export function strategyContextFit(strategy, { message = '', streamContext = {}, moment = {} } = {}) {
  const text = String(message || '');
  const hasGameContext = Boolean(streamContext?.gameName || streamContext?.streamTitle);
  const tactical = TACTICAL.test(text) || Number(moment?.tacticalHits || 0) > 0;
  const excited = POSITIVE.test(text) || Number(moment?.excitementHits || 0) > 0;
  const predictive = PREDICTIVE.test(text);

  switch (strategy) {
    case 'analysis':
      return tactical ? 1.45 : (hasGameContext ? 0.9 : 0.65);
    case 'prediction':
      return (predictive || hasGameContext) ? 1.3 : 0.72;
    case 'humor':
      return excited ? 1.35 : 0.9;
    case 'reflect':
    default:
      return 1.05;
  }
}

export function canAskQuestion({
  recentBotQuestions = 0,
  lastRetentionPromptAt = null,
  now = Date.now(),
  minGapMs = 45_000,
} = {}) {
  if (Number(recentBotQuestions || 0) >= 2) return false;
  if (lastRetentionPromptAt && now - Number(lastRetentionPromptAt) < minGapMs) return false;
  return true;
}

export function scoreRetentionArm({
  strategy,
  alpha,
  beta,
  context = {},
  repeatedStrategy = false,
  questionAllowed = true,
  rng = Math.random,
} = {}) {
  const sampledReplyProbability = sampleBeta(alpha, beta, rng);
  const contextFit = strategyContextFit(strategy, context);
  const repetitionPenalty = repeatedStrategy ? 0.68 : 1;
  const questionPenalty = !questionAllowed && strategy === 'prediction' ? 0.25 : 1;

  return {
    sampledReplyProbability,
    score: sampledReplyProbability * contextFit * repetitionPenalty * questionPenalty,
    contextFit,
  };
}

export function positiveMessage(message) {
  return POSITIVE.test(String(message || ''));
}

export function negativeMessage(message) {
  return NEGATIVE.test(String(message || ''));
}
