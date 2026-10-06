
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { config } from '../config/index.js';
import { createLogger } from '../logger/index.js';
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
  if (process.env.WORKERS_ENABLED !== 'true') return Promise.resolve(null);
  const queue = getQueue(queueName);
  return queue.add(queueName, data, { attempts: 3, backoff: { type: 'exponential', delay: 1000 }, ...opts });
}
export function startWorker(queueName, handler, concurrency = 1) {
  if (workers[queueName]) return workers[queueName];
  const worker = new Worker(queueName, async job => {
    log.info(`Processing job ${queueName}:${job.id}`);
    try { await handler(job.data); } catch (err) { log.error(`Job ${job.id} failed`, err); throw err; }
  }, { connection: getBullConnection(), concurrency });
  worker.on('completed', job => log.info(`Job ${job.id} completed`));
  worker.on('failed', (job, err) => log.error(`Job ${job.id} failed`, err));
  workers[queueName] = worker;
  return worker;
}
export async function drainQueues() {
  for (const [name, queue] of Object.entries(queues)) { await queue.drain(); }
  for (const [name, worker] of Object.entries(workers)) { await worker.close(); }
  if (bullConnection) { await bullConnection.quit(); bullConnection = null; }
}
