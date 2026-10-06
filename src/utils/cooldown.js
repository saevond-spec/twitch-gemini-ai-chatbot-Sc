export class CooldownManager {
  constructor(config) {
    this.globalCooldown = config.global || 1;
    this.userCooldown = config.perUser || 5;
    this.channelTimers = new Map();
    this.userTimers = new Map();
  }

  check(key) {
    const now = Date.now();
    const separator = key.lastIndexOf(':');
    const channelKey = separator > 0 ? key.slice(0, separator) : key;
    const lastChannel = this.channelTimers.get(channelKey) || 0;
    if (now - lastChannel < this.globalCooldown * 1000) return false;

    const lastUser = this.userTimers.get(key) || 0;
    if (now - lastUser < this.userCooldown * 1000) return false;

    this.channelTimers.set(channelKey, now);
    this.userTimers.set(key, now);
    return true;
  }
}
