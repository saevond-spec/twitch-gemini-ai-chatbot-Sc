export class AnalyticalMomentGate {
  constructor({ cooldownMs = 90_000, minScore = 72 } = {}) {
    this.cooldownMs = Math.max(10_000, Number(cooldownMs) || 90_000);
    this.minScore = Math.max(0, Math.min(100, Number(minScore) || 72));
    this.lastByChannel = new Map();
  }

  allow(channel, moment = {}, now = Date.now()) {
    const qualifies = Number(moment.score || 0) >= this.minScore
      && Number(moment.uniqueUsers || 0) >= 2
      && Number(moment.recentMessages || 0) >= 3
      && (Number(moment.tacticalHits || 0) >= 1 || Number(moment.excitementHits || 0) >= 2);

    if (!qualifies) return false;

    const key = String(channel || '').toLowerCase();
    const last = this.lastByChannel.get(key) || 0;
    if (now - last < this.cooldownMs) return false;

    this.lastByChannel.set(key, now);
    return true;
  }
}
