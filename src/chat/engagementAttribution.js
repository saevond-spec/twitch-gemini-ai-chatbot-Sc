export class EngagementAttribution {
  constructor({ quietResponseWindowMs = 120_000, analyticalResponseWindowMs = 90_000 } = {}) {
    this.quietResponseWindowMs = quietResponseWindowMs;
    this.analyticalResponseWindowMs = analyticalResponseWindowMs;
    this.quietByChannel = new Map();
    this.analyticalByChannel = new Map();
  }

  recordQuiet(channel, mode, now = Date.now()) {
    this.quietByChannel.set(String(channel).toLowerCase(), { at: now, mode, responded: false });
  }

  recordAnalytical(channel, now = Date.now()) {
    this.analyticalByChannel.set(String(channel).toLowerCase(), { at: now, responded: false });
  }

  recordHuman(channel, now = Date.now()) {
    const key = String(channel).toLowerCase();
    const result = { quietMode: null, analytical: false };

    const quiet = this.quietByChannel.get(key);
    if (quiet && !quiet.responded && now - quiet.at >= 0 && now - quiet.at <= this.quietResponseWindowMs) {
      quiet.responded = true;
      result.quietMode = quiet.mode;
    }

    const analytical = this.analyticalByChannel.get(key);
    if (analytical && !analytical.responded && now - analytical.at >= 0 && now - analytical.at <= this.analyticalResponseWindowMs) {
      analytical.responded = true;
      result.analytical = true;
    }

    return result;
  }
}
