import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from './config.js';

export const QUEUES = {
  maintenance: 'turnwise-maintenance',
  notifications: 'turnwise-notifications',
  recovery: 'turnwise-recovery',
};

export const redisConnection = () => new Redis(config.redisUrl, { maxRetriesPerRequest: null });

/** Bounded retries with exponential backoff; failed jobs stay visible for a week. */
export const deliveryJobOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { age: 24 * 3600 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export function makeQueue(name) {
  return new Queue(name, { connection: redisConnection() });
}
