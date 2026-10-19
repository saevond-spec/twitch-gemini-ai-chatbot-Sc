import {
  canAskQuestion,
  negativeMessage,
  retentionOpportunityScore,
  scoreRetentionArm,
} from './retentionMath.js';
import { RetentionStore } from './retentionStore.js';
import { localizedRetentionFallback } from './language.js';

export const RETENTION_STRATEGIES = Object.freeze(['reflect', 'humor', 'analysis', 'prediction']);

const INSTRUCTIONS = Object.freeze({
  reflect: 'Retention style: reflect the viewer’s actual point in one short sentence and add one relevant thought. Do not force a question. Keep it mobile-friendly and under two short sentences.',
  humor: 'Retention style: respond with one playful, game-relevant reaction that feels natural in Twitch chat. Leave an opening for them to continue, but do not force a question. Keep it mobile-friendly and under two short sentences.',
  analysis: 'Retention style: give one concise useful tactical observation based only on available chat/stream context. If you ask anything, ask at most one easy question. Keep it mobile-friendly and under two short sentences.',
  prediction: 'Retention style: ask one very easy either/or prediction about what happens next. Keep it answerable in a few words, mobile-friendly, and do not sound like a survey.',
});

function recentSignals(history = [], viewer = '', now = Date.now()) {
  const cutoff = now - 10 * 60 * 1000;
  const recent = (history || []).filter(entry => Number(entry?.ts || 0) >= cutoff);
  const recentHumanTurns = recent.filter(entry =>
    entry.role === 'user'
    && (!viewer || String(entry.username || '').toLowerCase() === String(viewer).toLowerCase())
  ).length;
  const recentBotQuestions = recent.filter(entry =>
    (entry.role === 'assistant' || entry.role === 'bot')
    && /\?/.test(String(entry.content || ''))
  ).length;
  return { recentHumanTurns, recentBotQuestions };
}

export class ConversationRetentionEngine {
  constructor({
    enabled = process.env.RETENTION_ENGINE_ENABLED !== 'false',
    minScore = Number(process.env.RETENTION_MIN_SCORE || 0.56),
    minPromptGapMs = Number(process.env.RETENTION_MIN_PROMPT_GAP_SECONDS || 45) * 1000,
    replyWindowMs = Number(process.env.RETENTION_REPLY_WINDOW_SECONDS || 120) * 1000,
    rng = Math.random,
  } = {}) {
    this.enabled = enabled;
    this.minScore = Number.isFinite(minScore) ? minScore : 0.56;
    this.minPromptGapMs = Number.isFinite(minPromptGapMs) ? minPromptGapMs : 45_000;
    this.replyWindowMs = Number.isFinite(replyWindowMs) ? replyWindowMs : 120_000;
    this.rng = rng;
  }

  async select({
    channel,
    viewer,
    profile,
    message,
    directInteraction,
    proactiveWelcome = false,
    offerFollow = false,
    offerSubscription = false,
    salesEligible = false,
    history = [],
    streamContext = {},
    moment = {},
    language = 'en',
    now = Date.now(),
  }) {
    if (!this.enabled) return { eligible: false, reason: 'disabled' };
    if (!directInteraction) return { eligible: false, reason: 'not_direct' };
    if (!profile || profile.proactiveOptOut) return { eligible: false, reason: 'opt_out' };
    if (negativeMessage(message)) return { eligible: false, reason: 'negative_context' };
    if (proactiveWelcome || offerFollow || offerSubscription || salesEligible) return { eligible: false, reason: 'trust_priority' };
    if (profile.lastRetentionPromptAt && now - Number(profile.lastRetentionPromptAt) < this.minPromptGapMs) {
      return { eligible: false, reason: 'prompt_gap' };
    }

    const { recentHumanTurns, recentBotQuestions } = recentSignals(history, viewer, now);
    const responseLatencyMs = profile.lastBotReplyAt
      ? Math.max(0, now - Number(profile.lastBotReplyAt))
      : null;

    const opportunity = retentionOpportunityScore({
      messageCount: profile.messageCount,
      botInteractions: profile.botInteractions,
      sessionAgeMs: profile.firstChatAt ? Math.max(0, now - Number(profile.firstChatAt)) : 0,
      recentHumanTurns,
      recentBotQuestions,
      responseLatencyMs,
      directInteraction,
      message,
      proactiveOptOut: profile.proactiveOptOut,
    });

    if (opportunity < this.minScore) {
      return { eligible: false, reason: 'low_opportunity', opportunity };
    }

    const questionAllowed = canAskQuestion({
      recentBotQuestions,
      lastRetentionPromptAt: profile.lastRetentionPromptAt,
      now,
      minGapMs: this.minPromptGapMs,
    });

    const arms = [];
    for (const strategy of RETENTION_STRATEGIES) {
      const stats = await RetentionStore.getStrategyStats(strategy, language);
      const scored = scoreRetentionArm({
        strategy,
        alpha: stats.alpha,
        beta: stats.beta,
        context: { message, streamContext, moment },
        repeatedStrategy: profile.lastRetentionStrategy === strategy,
        questionAllowed,
        rng: this.rng,
      });
      arms.push({ strategy, stats, ...scored });
    }

    arms.sort((a, b) => b.score - a.score);
    const selected = arms[0];
    return {
      eligible: true,
      opportunity,
      questionAllowed,
      strategy: selected.strategy,
      language,
      banditScore: selected.score,
      sampledReplyProbability: selected.sampledReplyProbability,
      instruction: questionAllowed
        ? INSTRUCTIONS[selected.strategy]
        : `${INSTRUCTIONS[selected.strategy]} Do not ask a question this turn; the viewer has already received enough questions recently.`,
    };
  }

  async recordImpression({ channel, viewer, selection, at = Date.now() }) {
    if (!selection?.eligible) return;
    return RetentionStore.recordImpression({
      channel,
      viewer,
      strategy: selection.strategy,
      language: selection.language || 'en',
      at,
      replyWindowMs: this.replyWindowMs,
    });
  }

  async recordReply({ channel, viewer, at = Date.now() }) {
    return RetentionStore.recordReply({ channel, viewer, at });
  }

  async stats(language = 'global') {
    return RetentionStore.getAllStats(RETENTION_STRATEGIES, language);
  }

  localFallback({ username = '', strategy = 'reflect', questionAllowed = true, language = 'en' } = {}) {
    return localizedRetentionFallback({
      code: language,
      username,
      strategy,
      questionAllowed,
    });
  }
}
