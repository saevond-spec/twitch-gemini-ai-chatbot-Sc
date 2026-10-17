export class ProactiveWelcomeLimiter {
  constructor({ maxPerWindow = 3, windowMs = 60_000 } = {}) {
    this.maxPerWindow = Math.max(1, Number(maxPerWindow) || 3);
    this.windowMs = Math.max(1000, Number(windowMs) || 60_000);
    this.events = new Map();
  }

  allow(channel, now = Date.now()) {
    const key = String(channel || '').toLowerCase();
    const recent = (this.events.get(key) || []).filter(ts => now - ts < this.windowMs);
    if (recent.length >= this.maxPerWindow) {
      this.events.set(key, recent);
      return false;
    }
    recent.push(now);
    this.events.set(key, recent);
    return true;
  }
}
