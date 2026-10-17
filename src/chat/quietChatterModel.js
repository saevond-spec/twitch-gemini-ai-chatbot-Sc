export function quietSpeakProbability({
  silenceMs,
  tickMs = 30_000,
  recentBotMessages = 0,
  minQuietMs = 150_000,
  maxQuietMs = 720_000,
}) {
  if (!Number.isFinite(silenceMs) || silenceMs < minQuietMs) return 0;

  const midpoint = minQuietMs + (maxQuietMs - minQuietMs) * 0.38;
  const scale = Math.max(30_000, (maxQuietMs - minQuietMs) / 7);
  const activation = 1 / (1 + Math.exp(-(silenceMs - midpoint) / scale));

  // Fatigue falls exponentially as the bot has spoken more often recently.
  const fatigue = Math.exp(-0.72 * Math.max(0, recentBotMessages));

  // Fully-quiet target hazard ~= one attempt every 4.5 minutes before fatigue.
  const lambdaPerMs = (1 / (4.5 * 60_000)) * activation * fatigue;
  let probability = 1 - Math.exp(-lambdaPerMs * tickMs);

  // Guarantee a useful nudge after prolonged silence without turning chat into a wall of bot messages.
  if (silenceMs >= maxQuietMs && recentBotMessages === 0) probability = Math.max(probability, 0.65);
  return Math.max(0, Math.min(0.75, probability));
}

export function chooseQuietMode({ history = [], streamContext = {}, moment = {} }) {
  const recentHuman = history.filter(entry => entry.role === 'user').slice(-8);
  const hasGameContext = Boolean(streamContext.gameName || streamContext.streamTitle);
  const tactical = recentHuman.some(entry => /\b(play|fight|weapon|build|strat|strategy|rotate|parry|clutch|position|extract|revive|combo|ability)\b/i.test(entry.content || ''));

  if (moment.analytical || (hasGameContext && tactical)) return 'analysis-recap';
  if (hasGameContext) return 'prediction';
  return 'community-question';
}

export function quietPrompt(mode, { gameName = '', streamTitle = '' } = {}) {
  const context = [gameName, streamTitle].filter(Boolean).join(' — ');
  if (mode === 'analysis-recap') {
    return `Chat has gone quiet. Give one concise analyst-style recap or tactical observation based ONLY on the recent chat/context you have. If evidence is thin, say what you'd watch for next instead of inventing gameplay. End with one easy question. Context: ${context || 'gaming stream'}`;
  }
  if (mode === 'prediction') {
    return `Chat is quiet. Start a low-pressure prediction or strategy question about the current game/stream. Make it easy to answer in a few words. Do not ask for follows, subs, money, or spam emotes. Context: ${context || 'gaming stream'}`;
  }
  return 'Chat is quiet. Ask one short, fun gaming question that a lurker could answer with a few words. Do not ask for follows, subs, money, or personal information.';
}
