import { sampleBeta } from '../commerce/math.js';

export const LURKER_PROMPT_ARMS = Object.freeze(['binary', 'emote', 'rating', 'prediction']);

export function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

export function activationOpportunity({
  silentUsers = 0,
  silenceMs = 0,
  recentHumanMessages = 0,
  recentBotMessages = 0,
  recentActivationPrompts = 0,
  lastPromptAt = null,
  now = Date.now(),
  minPromptGapMs = 180_000,
} = {}) {
  if (Number(silentUsers || 0) < 1) return 0;
  if (lastPromptAt && now - Number(lastPromptAt) < minPromptGapMs) return 0;

  const silentSignal = Math.log1p(Math.max(0, Number(silentUsers) || 0));
  const quietMinutes = clamp((Number(silenceMs) || 0) / 60_000, 0, 8);
  const humanPenalty = 0.34 * clamp(recentHumanMessages, 0, 6);
  const botPenalty = 0.58 * clamp(recentBotMessages, 0, 5);
  const fatiguePenalty = 0.95 * clamp(recentActivationPrompts, 0, 3);

  const linear = -3.35
    + 0.95 * silentSignal
    + 0.38 * quietMinutes
    - humanPenalty
    - botPenalty
    - fatiguePenalty;

  return clamp(sigmoid(linear), 0, 0.92);
}

export function promptContextFit(arm, { gameName = '', tactical = false, excitement = false } = {}) {
  const hasGame = Boolean(String(gameName || '').trim());
  switch (arm) {
    case 'binary':
      return hasGame ? 1.18 : 1.05;
    case 'prediction':
      return hasGame ? (tactical ? 1.36 : 1.2) : 0.82;
    case 'emote':
      return excitement ? 1.28 : 1.02;
    case 'rating':
    default:
      return 1.08;
  }
}

export function scorePromptArm({
  arm,
  alpha,
  beta,
  context = {},
  repeatedArm = false,
  recentPromptCount = 0,
  rng = Math.random,
} = {}) {
  const sampledActivationProbability = sampleBeta(alpha, beta, rng);
  const contextFit = promptContextFit(arm, context);
  const repetitionPenalty = repeatedArm ? 0.68 : 1;
  const fatigue = Math.exp(-0.42 * Math.max(0, Number(recentPromptCount) || 0));

  return {
    sampledActivationProbability,
    contextFit,
    fatigue,
    score: sampledActivationProbability * contextFit * repetitionPenalty * fatigue,
  };
}

export function promptForArm(arm, { gameName = '' } = {}) {
  const game = String(gameName || '').trim();
  switch (arm) {
    case 'binary':
      return game
        ? `Chat micro-vote: ⚔️ push or 🛡️ reset?`
        : 'Chat micro-vote: aggressive or safe? ⚔️🛡️';
    case 'emote':
      return 'One-emote check: 🔥 = clean, 💀 = chaos.';
    case 'rating':
      return 'Quick score, chat: 1–10? One number is enough 🤖';
    case 'prediction':
      return game
        ? `Next ${game} moment: W or chaos? 👀`
        : 'Next play: W or chaos? 👀';
    default:
      return 'Quick chat check: W or chaos? 👀';
  }
}
