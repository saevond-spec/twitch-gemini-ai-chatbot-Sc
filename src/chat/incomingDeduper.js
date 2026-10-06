export class IncomingMessageDeduper {
  constructor(ttlMs = 2 * 60 * 1000) {
    this.ttlMs = ttlMs;
    this.seen = new Map();
  }

  isDuplicate(channel, user = {}) {
    const messageId = user.id || user['message-id'];
    if (!messageId) return false;
    const now = Date.now();
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(key);
    }
    const key = `${channel}:${messageId}`;
    if (this.seen.has(key)) return true;
    this.seen.set(key, now + this.ttlMs);
    return false;
  }
}
