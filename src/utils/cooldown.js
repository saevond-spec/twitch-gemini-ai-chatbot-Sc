// src/utils/cooldown.js
export class CooldownManager {
  constructor(config) {
    this.globalCooldown = config.global || 1;
    this.userCooldown = config.perUser || 5;
    this.lastGlobal = 0;
    this.userTimers = new Map();
  }

  check(key) {
    const now = Date.now();
    // Check global cooldown
    if (now - this.lastGlobal < this.globalCooldown * 1000) {
      return false;
    }
    // Check user cooldown
    const lastUser = this.userTimers.get(key) || 0;
    if (now - lastUser < this.userCooldown * 1000) {
      return false;
    }
    // If we get here, cooldown is not active – update timestamps
    this.lastGlobal = now;
    this.userTimers.set(key, now);
    return true;
  }
}
