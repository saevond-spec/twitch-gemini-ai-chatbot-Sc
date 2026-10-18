import {
  activationOpportunity,
  LURKER_PROMPT_ARMS,
  promptForArm,
  scorePromptArm,
} from './lurkerActivationMath.js';
import { LurkerActivationStore } from './lurkerActivationStore.js';

const DEFAULT_MAX_SILENT_AGE_MS = 4 * 60 * 60 * 1000;

export class LurkerActivationEngine {
  constructor({
    enabled = process.env.LURKER_ACTIVATION_ENABLED !== 'false',
    minSilentMs = Number(process.env.LURKER_MIN_SILENT_SECONDS || 180) * 1000,
    minPromptGapMs = Number(process.env.LURKER_PROMPT_GAP_SECONDS || 240) * 1000,
    replyWindowMs = Number(process.env.LURKER_REPLY_WINDOW_SECONDS || 120) * 1000,
    minOpportunity = Number(process.env.LURKER_MIN_OPPORTUNITY || 0.42),
    warmupMs = Number(process.env.LURKER_TRACKING_WARMUP_SECONDS || 90) * 1000,
    rng = Math.random,
    now = () => Date.now(),
  } = {}) {
    this.enabled = enabled;
    this.minSilentMs = Math.max(60_000, Number(minSilentMs) || 180_000);
    this.minPromptGapMs = Math.max(120_000, Number(minPromptGapMs) || 240_000);
    this.replyWindowMs = Math.max(30_000, Number(replyWindowMs) || 120_000);
    this.minOpportunity = Math.max(0.05, Math.min(0.95, Number(minOpportunity) || 0.42));
    this.warmupMs = Math.max(0, Number(warmupMs) || 90_000);
    this.rng = rng;
    this.now = now;
    this.startedAt = this.now();
    this.silent = new Map();
    this.channelState = new Map();
  }

  _channel(channel) {
    return String(channel || '').replace(/^#?/, '#').toLowerCase();
  }

  _users(channel) {
    const key = this._channel(channel);
    if (!this.silent.has(key)) this.silent.set(key, new Map());
    return this.silent.get(key);
  }

  _state(channel) {
    const key = this._channel(channel);
    if (!this.channelState.has(key)) {
      this.channelState.set(key, {
        lastPromptAt: 0,
        lastArm: null,
        promptTimes: [],
      });
    }
    return this.channelState.get(key);
  }

  _prune(channel, now = this.now()) {
    const users = this._users(channel);
    for (const [username, entry] of users) {
      if (now - Number(entry.joinedAt || 0) > DEFAULT_MAX_SILENT_AGE_MS) users.delete(username);
    }
    const state = this._state(channel);
    state.promptTimes = state.promptTimes.filter(at => now - at <= 20 * 60_000);
  }

  onJoin({ channel, username, now = this.now() } = {}) {
    if (!this.enabled || !channel || !username) return false;
    if (now - this.startedAt < this.warmupMs) return false;
    const users = this._users(channel);
    const login = String(username).toLowerCase();
    if (!users.has(login)) users.set(login, { joinedAt: now });
    return true;
  }

  onPart({ channel, username } = {}) {
    if (!channel || !username) return;
    this._users(channel).delete(String(username).toLowerCase());
  }

  async onMessage({ channel, username, now = this.now() } = {}) {
    if (!this.enabled || !channel || !username) return { wasSilent: false, attributed: false };
    this._prune(channel, now);

    const users = this._users(channel);
    const login = String(username).toLowerCase();
    const entry = users.get(login);
    users.delete(login);
    if (!entry) return { wasSilent: false, attributed: false };

    const silentMs = now - Number(entry.joinedAt || now);
    if (silentMs < this.minSilentMs) return { wasSilent: false, attributed: false };

    const active = await LurkerActivationStore.getActivePrompt(channel, now);
    if (!active || Number(entry.joinedAt || now) > Number(active.at || 0)) {
      return { wasSilent: true, attributed: false, reason: 'organic_first_chat' };
    }

    const result = await LurkerActivationStore.recordActivation({ channel, at: now });
    return {
      wasSilent: true,
      ...result,
      silentMs,
    };
  }

  eligibleSilentCount(channel, now = this.now()) {
    this._prune(channel, now);
    let count = 0;
    for (const entry of this._users(channel).values()) {
      const age = now - Number(entry.joinedAt || now);
      if (age >= this.minSilentMs && age <= DEFAULT_MAX_SILENT_AGE_MS) count += 1;
    }
    return count;
  }

  async consider({
    channel,
    silenceMs,
    recentHumanMessages = 0,
    recentBotMessages = 0,
    streamContext = {},
    moment = {},
    now = this.now(),
  } = {}) {
    if (!this.enabled) return { eligible: false, reason: 'disabled' };
    const silentUsers = this.eligibleSilentCount(channel, now);
    if (!silentUsers) return { eligible: false, reason: 'no_silent_users', silentUsers };

    const state = this._state(channel);
    const recentActivationPrompts = state.promptTimes.filter(at => now - at <= 15 * 60_000).length;
    const opportunity = activationOpportunity({
      silentUsers,
      silenceMs,
      recentHumanMessages,
      recentBotMessages,
      recentActivationPrompts,
      lastPromptAt: state.lastPromptAt,
      now,
      minPromptGapMs: this.minPromptGapMs,
    });

    if (opportunity < this.minOpportunity) {
      return {
        eligible: false,
        reason: 'low_opportunity',
        silentUsers,
        opportunity,
      };
    }

    // Treat opportunity as a per-check hazard rather than an instruction to
    // always speak. This keeps prompts sparse even when silent users are present.
    if (this.rng() > opportunity) {
      return {
        eligible: false,
        reason: 'stochastic_hold',
        silentUsers,
        opportunity,
      };
    }

    const context = {
      gameName: streamContext?.gameName || '',
      tactical: Number(moment?.tacticalHits || 0) > 0,
      excitement: Number(moment?.excitementHits || 0) > 0,
    };
    const arms = [];
    for (const arm of LURKER_PROMPT_ARMS) {
      const stats = await LurkerActivationStore.getArmStats(channel, arm);
      const scored = scorePromptArm({
        arm,
        alpha: stats.alpha,
        beta: stats.beta,
        context,
        repeatedArm: state.lastArm === arm,
        recentPromptCount: recentActivationPrompts,
        rng: this.rng,
      });
      arms.push({ arm, stats, ...scored });
    }
    arms.sort((a, b) => b.score - a.score);
    const selected = arms[0];

    return {
      eligible: true,
      arm: selected.arm,
      message: promptForArm(selected.arm, context),
      opportunity,
      silentUsers,
      banditScore: selected.score,
      sampledActivationProbability: selected.sampledActivationProbability,
    };
  }

  async recordPrompt({ channel, selection, at = this.now() }) {
    if (!selection?.eligible) return null;
    const state = this._state(channel);
    state.lastPromptAt = at;
    state.lastArm = selection.arm;
    state.promptTimes.push(at);
    return LurkerActivationStore.recordPrompt({
      channel,
      arm: selection.arm,
      eligibleSilentUsers: selection.silentUsers,
      at,
      windowMs: this.replyWindowMs,
    });
  }

  async stats(channel) {
    return LurkerActivationStore.getAllStats(channel, LURKER_PROMPT_ARMS);
  }

  stop() {
    this.silent.clear();
    this.channelState.clear();
  }
}
