
export class Moderation {
  constructor(config) {
    this.maxRepeats = config.maxRepeats || 3;
    this.maxCapsRatio = config.maxCapsRatio || 0.7;
    this.linkFilter = config.linkFilter !== false;
    this.messageHistory = new Map();
  }
  analyze(channel, user, message) {
    const username = user.username.toLowerCase();
    if (user.badges?.broadcaster || user.mod || user.badges?.vip) {
      return { blocked: false, riskScore: 0 };
    }
    let riskScore = 0;
    const history = this.messageHistory.get(username) || [];
    const now = Date.now();
    const recent = history.filter(h => now - h.time < 10000);
    const sameMsgCount = recent.filter(h => h.text === message).length;
    if (sameMsgCount >= this.maxRepeats) riskScore += 50;
    this.messageHistory.set(username, [...recent, { time: now, text: message }]);
    const letters = message.replace(/[^a-zA-Z]/g, '');
    if (letters.length > 5) {
      const caps = (message.match(/[A-Z]/g) || []).length;
      if (caps / letters.length > this.maxCapsRatio) riskScore += 30;
    }
    if (this.linkFilter && /https?:\/\/\S+/i.test(message)) riskScore += 40;
    if (/(.)\1{5,}/.test(message)) riskScore += 20;
    const blocked = riskScore >= 70;
    return { blocked, riskScore };
  }
  isAllowed(channel, user, message) {
    return !this.analyze(channel, user, message).blocked;
  }
}
