const LIVE_STATE = 'LIVE';

export class SleipnirLiveState {
  constructor({ staleAfterMs = 90_000, now = () => Date.now() } = {}) {
    this.staleAfterMs = Math.max(15_000, Number(staleAfterMs) || 90_000);
    this.now = typeof now === 'function' ? now : Date.now;
    this.reset();
  }

  reset() {
    this.lastSeenAt = 0;
    this.sessionId = null;
    this.state = 'UNKNOWN';
    this.bytesPerSecond = 0;
    this.reconnects = 0;
    this.source = null;
  }

  observe(record = {}) {
    const seenAt = this.now();

    if (record.kind === 'encoder_connection_sample') {
      const destination = Array.isArray(record.destinations)
        ? record.destinations.find(item => item?.id === 'sleipnir')
        : null;
      if (!destination) return false;

      this.lastSeenAt = seenAt;
      this.sessionId = record.sessionId || this.sessionId;
      this.state = String(destination.state || 'UNKNOWN').toUpperCase();
      this.bytesPerSecond = Number(destination.bytesPerSecond || 0);
      this.reconnects = Number(destination.reconnects || 0);
      this.source = 'encoder-telemetry';
      return true;
    }

    if (record.kind === 'encoder_app_event' && record.target === 'sleipnir') {
      const result = String(record.result || '').toLowerCase();
      const stateByResult = {
        live: 'LIVE',
        connecting: 'CONNECTING',
        retrying: 'RETRYING',
        waiting: 'WAITING FOR KEYFRAME',
        stopped: 'STOPPED',
        failed: 'FAILED',
        disconnected: 'STOPPED',
      };
      const next = stateByResult[result];
      if (!next) return false;

      this.lastSeenAt = seenAt;
      this.sessionId = record.sessionId || this.sessionId;
      this.state = next;
      this.source = 'encoder-event';
      return true;
    }

    return false;
  }

  snapshot(now = this.now()) {
    const ageMs = this.lastSeenAt ? Math.max(0, Number(now) - this.lastSeenAt) : null;
    const fresh = ageMs !== null && ageMs <= this.staleAfterMs;
    return {
      configured: true,
      fresh,
      live: fresh && this.state === LIVE_STATE,
      state: fresh ? this.state : 'UNKNOWN',
      source: fresh ? this.source : null,
      sessionId: fresh ? this.sessionId : null,
      bytesPerSecond: fresh ? this.bytesPerSecond : 0,
      reconnects: fresh ? this.reconnects : 0,
      lastSeenAt: this.lastSeenAt || null,
      ageMs,
      staleAfterMs: this.staleAfterMs,
    };
  }

  resolveStreamContext(streamContext = {}, now = this.now()) {
    const twitchLive = Boolean(streamContext?.live);
    const sleipnir = this.snapshot(now);
    const liveSources = [];
    if (twitchLive) liveSources.push('twitch');
    if (sleipnir.live) liveSources.push('sleipnir');

    return {
      ...streamContext,
      live: twitchLive || sleipnir.live,
      liveSources,
      sleipnir,
    };
  }
}
