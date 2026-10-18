
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { config } from '../config/index.js';
import { createLogger } from '../logger/index.js';
import { getRedis } from '../storage/redis.js';
import { enabledWorkerQueues, workerRedisBudget } from './workerPolicy.js';
const log = createLogger('QUEUE');
let queues = {};
let workers = {};

let bullConnection = null;
function getBullConnection() {
  if (!bullConnection) {
    if (!config.redis.url) throw new Error('Redis not connected');
    bullConnection = new Redis(config.redis.url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    bullConnection.on('error', (err) => log.error('BullMQ Redis connection error', err));
  }
  return bullConnection;
}

export function getQueue(name) {
  if (!queues[name]) {
    queues[name] = new Queue(name, { connection: getBullConnection() });
  }
  return queues[name];
}
export function enqueueTask(queueName, data, opts = {}) {
  const enabled = enabledWorkerQueues([queueName]);
  if (!enabled.includes(queueName)) {
    log.debug(`Skipping queue ${queueName}: no active worker policy for this queue`);
    return Promise.resolve(null);
  }
  if (!getRedis()) {
    log.warn(`Skipping queue ${queueName}: Redis is unavailable; core chat continues without background jobs`);
    return Promise.resolve(null);
  }
  const queue = getQueue(queueName);
  return queue.add(queueName, data, { attempts: 3, backoff: { type: 'exponential', delay: 1000 }, ...opts });
}
export function startWorker(queueName, handler, concurrency = 1) {
  if (workers[queueName]) return workers[queueName];
  if (!enabledWorkerQueues([queueName]).includes(queueName)) return null;
  if (!getRedis()) {
    log.warn(`Not starting ${queueName} worker: Redis unavailable`);
    return null;
  }

  const { drainDelaySeconds, stalledIntervalMs } = workerRedisBudget();
  const worker = new Worker(queueName, async job => {
    log.info(`Processing job ${queueName}:${job.id}`);
    try { await handler(job.data); } catch (err) { log.error(`Job ${job.id} failed`, err); throw err; }
  }, {
    connection: getBullConnection(),
    concurrency,
    drainDelay: drainDelaySeconds,
    stalledInterval: stalledIntervalMs,
  });
  worker.on('completed', job => log.info(`Job ${job.id} completed`));
  worker.on('failed', (job, err) => log.error(`Job ${job.id} failed`, err));
  workers[queueName] = worker;
  return worker;
}
export async function drainQueues() {
  for (const worker of Object.values(workers)) await worker.close();
  for (const queue of Object.values(queues)) await queue.close();
  workers = {};
  queues = {};
  if (bullConnection) { await bullConnection.quit(); bullConnection = null; }
}
