export function finalWindowSignals(messages, followEvents = []) {
  const evidence = Array.isArray(messages)
    ? messages.filter((entry) => String(entry?.message || '').trim()) : [];
  if (!evidence.length) return null;
  const uniqueUsers = new Set(evidence.map((entry) => String(entry?.username || 'viewer'))).size;
  const totalExcitement = evidence.reduce((sum, entry) => {
    const score = Number(entry?.excitement);
    return sum + (Number.isFinite(score) ? Math.max(0, score) : 0);
  }, 0);
  return {
    finalWindow: true,
    explicitClip: evidence.some((entry) => /\bclip(?: it| that)?\b/i.test(String(entry?.message || ''))),
    uniqueUsers,
    totalExcitement,
    followCount: Array.isArray(followEvents) ? followEvents.length : 0
  };
}

export function finalWindowOffsetSeconds(startedAt, messages, fallbackAt = Date.now()) {
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return 0;
  const observed = Array.isArray(messages)
    ? messages.map((entry) => Number(entry?.at)).filter(Number.isFinite) : [];
  const fallback = fallbackAt instanceof Date ? fallbackAt.getTime() : Number(fallbackAt);
  const end = observed.length ? Math.max(...observed) : fallback;
  if (!Number.isFinite(end)) return 0;
  return Math.max(0, (end - start) / 1000);
}
