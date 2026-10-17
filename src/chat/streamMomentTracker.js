const TACTICAL = /\b(parry|clutch|rotate|rotation|position|positioning|timing|angle|flank|push|retreat|heal|reload|dodge|counter|punish|combo|ult|ultimate|ability|cooldown|peek|cover|extract|revive|third party|1v1|1v2|1v3|fight|play|mistake|decision)\b/i;
const EXCITED = /\b(no way|holy|insane|crazy|clutch|wow|wtf|omg|goated|clean|nice|huge)\b/i;

export function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

export class StreamMomentTracker {
  constructor({ horizonMs = 60_000, spikeWindowMs = 10_000 } = {}) {
    this.horizonMs = horizonMs;
    this.spikeWindowMs = spikeWindowMs;
    this.events = new Map();
  }

  observe(channel, { username, message, now = Date.now() }) {
    const key = String(channel || '').toLowerCase();
    const list = this.events.get(key) || [];
    list.push({ at: now, username: String(username || 'viewer'), message: String(message || '') });
    const recent = list.filter(event => now - event.at <= this.horizonMs);
    this.events.set(key, recent);
    return this.snapshot(channel, now);
  }

  snapshot(channel, now = Date.now()) {
    const key = String(channel || '').toLowerCase();
    const events = (this.events.get(key) || []).filter(event => now - event.at <= this.horizonMs);
    this.events.set(key, events);

    const spike = events.filter(event => now - event.at <= this.spikeWindowMs);
    const baseline = events.filter(event => now - event.at > this.spikeWindowMs);
    const spikeSeconds = this.spikeWindowMs / 1000;
    const baselineSeconds = Math.max(1, (this.horizonMs - this.spikeWindowMs) / 1000);

    const recentRate = spike.length / spikeSeconds;
    const baselineRate = baseline.length / baselineSeconds;
    const expectedRecent = Math.max(0.25, baselineRate * spikeSeconds);
    const poissonZ = (spike.length - expectedRecent) / Math.sqrt(expectedRecent + 0.5);

    const uniqueUsers = new Set(spike.map(event => event.username.toLowerCase())).size;
    const tacticalHits = spike.filter(event => TACTICAL.test(event.message)).length;
    const excitementHits = spike.filter(event => EXCITED.test(event.message) || /[!?]{2,}/.test(event.message)).length;

    const tacticalSignal = Math.min(1.5, tacticalHits / 2);
    const excitementSignal = Math.min(1.5, excitementHits / 2);
    const diversitySignal = Math.min(1.5, Math.log1p(uniqueUsers) / Math.log(4));

    // Logistic score: rate spike matters most, but tactical language + independent viewers add evidence.
    const linear = -2.35
      + 0.62 * Math.max(-1, Math.min(4, poissonZ))
      + 0.95 * tacticalSignal
      + 0.75 * excitementSignal
      + 0.65 * diversitySignal;
    const score = Math.round(100 * sigmoid(linear));

    return {
      score,
      poissonZ: Number(poissonZ.toFixed(2)),
      recentMessages: spike.length,
      uniqueUsers,
      tacticalHits,
      excitementHits,
      recentRatePerMinute: Number((recentRate * 60).toFixed(1)),
      baselineRatePerMinute: Number((baselineRate * 60).toFixed(1)),
      hot: score >= 70,
      analytical: score >= 58 || tacticalHits >= 2,
    };
  }
}
