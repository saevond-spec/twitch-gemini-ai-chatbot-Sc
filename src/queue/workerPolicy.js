export function enabledWorkerQueues(availableQueues = [], env = process.env) {
  if (env.WORKERS_ENABLED !== 'true') return [];

  const available = new Set(availableQueues);
  const raw = String(env.WORKER_QUEUES || 'auto').trim().toLowerCase();

  if (raw === 'none' || raw === 'off' || raw === 'false') return [];

  if (raw !== 'auto') {
    return [...new Set(raw.split(',')
      .map(value => value.trim())
      .filter(Boolean)
      .filter(name => available.has(name)))];
  }

  const deliveryEnabled = env.YOUTUBE_UPLOAD_ENABLED === 'true'
    || env.TIKTOK_UPLOAD_ENABLED === 'true'
    || env.DISCORD_ANNOUNCE_ENABLED === 'true';

  const queues = [];
  if (deliveryEnabled && available.has('generate-clips')) queues.push('generate-clips');

  // moderation-review currently only logs locally, so a permanent Redis worker
  // would spend requests without adding durable review behavior.
  return queues;
}

export function workerRedisBudget(env = process.env) {
  const drainDelaySeconds = Math.max(10, Math.min(600, Number(env.BULLMQ_DRAIN_DELAY_SECONDS || 120)));
  const stalledIntervalSeconds = Math.max(30, Math.min(900, Number(env.BULLMQ_STALLED_INTERVAL_SECONDS || 300)));
  return {
    drainDelaySeconds,
    stalledIntervalMs: stalledIntervalSeconds * 1000,
  };
}

export function estimatedMonthlyIdlePolls(workerCount, {
  drainDelaySeconds = 120,
  stalledIntervalMs = 300_000,
  days = 30,
} = {}) {
  const count = Math.max(0, Number(workerCount) || 0);
  const seconds = Math.max(1, Number(drainDelaySeconds) || 120);
  const stalledSeconds = Math.max(1, Number(stalledIntervalMs) || 300_000) / 1000;
  const totalSeconds = Math.max(1, Number(days) || 30) * 24 * 60 * 60;

  return Math.ceil(count * (
    totalSeconds / seconds
    + totalSeconds / stalledSeconds
  ));
}
