export class EventSubDeduper {
  constructor({ ttlMs = 10 * 60 * 1000, maxAgeMs = 10 * 60 * 1000 } = {}) {
    this.ttlMs = ttlMs;
    this.maxAgeMs = maxAgeMs;
    this.seen = new Map();
  }

  shouldProcess(metadata = {}, now = Date.now()) {
    const messageId = metadata.message_id;
    const timestamp = Date.parse(metadata.message_timestamp || '');
    if (!messageId) return true;

    for (const [id, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(id);
    }

    if (Number.isFinite(timestamp) && now - timestamp > this.maxAgeMs) return false;
    if (this.seen.has(messageId)) return false;

    this.seen.set(messageId, now + this.ttlMs);
    return true;
  }
}
