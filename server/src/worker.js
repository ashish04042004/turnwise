import { Worker } from 'bullmq';
import { closeCache } from './cache.js';
import { config } from './config.js';
import { pool, withTx } from './db.js';
import { startCacheInvalidation } from './invalidation.js';
import { deliveryJobOptions, makeQueue, QUEUES, redisConnection } from './queue.js';
import { expireHolds } from './services/booking.js';
import { sweepOverruns } from './services/operations.js';
import { recoverCapacity } from './services/waitlist.js';

await startCacheInvalidation();

const maintenance = makeQueue(QUEUES.maintenance);
const notifications = makeQueue(QUEUES.notifications);
const recovery = makeQueue(QUEUES.recovery);

const centreIds = async () => (await pool.query('SELECT id FROM centres')).rows.map((r) => r.id);

/**
 * Moves committed outbox rows onto BullMQ. The job id is derived from the
 * outbox row, so re-relaying a row (after a crash between enqueue and the
 * status update) cannot create a duplicate job.
 */
async function relayOutbox() {
  return withTx(async (tx) => {
    const { rows } = await tx.query(
      `SELECT id, topic, centre_id FROM outbox
       WHERE status = 'pending' OR (status = 'dispatched' AND dispatched_at < now() - interval '2 minutes')
       ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED`,
    );
    for (const row of rows) {
      const queue = row.topic === 'notify.patient' ? notifications : recovery;
      await queue.add(row.topic, { outboxId: row.id }, { ...deliveryJobOptions, jobId: `${row.centre_id}-${row.id}` });
    }
    if (rows.length) await tx.query(`UPDATE outbox SET status = 'dispatched', dispatched_at = now() WHERE id = ANY($1)`, [rows.map((r) => r.id)]);
    return rows.length;
  });
}

async function loadOutbox(id) {
  const { rows } = await pool.query(`SELECT * FROM outbox WHERE id = $1`, [id]);
  return rows[0];
}

const markAttempt = (id) => pool.query(`UPDATE outbox SET attempts = attempts + 1 WHERE id = $1`, [id]);

async function onFailed(job, err) {
  if (!job) return;
  const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
  await pool.query(`UPDATE outbox SET last_error = $2, status = CASE WHEN $3 THEN 'failed' ELSE status END WHERE id = $1`, [
    job.data.outboxId,
    err.message,
    exhausted,
  ]);
  console.warn(`[worker] ${job.name} outbox#${job.data.outboxId} attempt ${job.attemptsMade} failed: ${err.message}${exhausted ? ' (giving up)' : ''}`);
}

const workers = [
  new Worker(
    QUEUES.maintenance,
    async (job) => {
      const ids = await centreIds();
      switch (job.name) {
        case 'expire-holds': {
          let n = 0;
          for (const id of ids) n += await withTx((tx) => expireHolds(tx, id));
          return { expired: n };
        }
        case 'relay-outbox':
          return { relayed: await relayOutbox() };
        case 'sweep-overruns': {
          let n = 0;
          for (const id of ids) n += await sweepOverruns(id);
          return { extended: n };
        }
        default:
          throw new Error(`Unknown maintenance job ${job.name}`);
      }
    },
    { connection: redisConnection(), concurrency: 1 },
  ),

  // Delivery is simulated; NOTIFY_FAILURE_RATE injects gateway failures to exercise retries.
  new Worker(
    QUEUES.notifications,
    async (job) => {
      const row = await loadOutbox(job.data.outboxId);
      if (!row || row.status === 'delivered') return 'already delivered';
      await markAttempt(row.id);
      if (Math.random() < config.notifyFailureRate) throw new Error('Simulated SMS gateway timeout');
      await withTx(async (tx) => {
        await tx.query(
          `INSERT INTO notifications (outbox_id, centre_id, channel, recipient, body) VALUES ($1, $2, 'sms', $3, $4)
           ON CONFLICT (outbox_id) DO NOTHING`,
          [row.id, row.centre_id, row.payload.recipient, row.payload.message],
        );
        await tx.query(`UPDATE outbox SET status = 'delivered', delivered_at = now(), last_error = NULL WHERE id = $1`, [row.id]);
      });
      return 'delivered';
    },
    { connection: redisConnection(), concurrency: 5 },
  ),

  new Worker(
    QUEUES.recovery,
    async (job) => {
      const row = await loadOutbox(job.data.outboxId);
      if (!row || row.status === 'delivered') return 'already processed';
      await markAttempt(row.id);
      return recoverCapacity(row.centre_id, row.payload, row.id);
    },
    { connection: redisConnection(), concurrency: 2 },
  ),
];

for (const w of workers.slice(1)) w.on('failed', (job, err) => onFailed(job, err).catch(console.error));
workers[0].on('failed', (job, err) => console.error(`[worker] ${job?.name} failed:`, err.message));

await maintenance.upsertJobScheduler('expire-holds', { every: 10_000 }, { name: 'expire-holds' });
await maintenance.upsertJobScheduler('relay-outbox', { every: 2_000 }, { name: 'relay-outbox' });
await maintenance.upsertJobScheduler('sweep-overruns', { every: 30_000 }, { name: 'sweep-overruns' });

console.log('[worker] Turnwise worker running: hold expiry, outbox relay, overrun sweeper, notifications, capacity recovery');

async function shutdown() {
  await Promise.allSettled(workers.map((w) => w.close()));
  await Promise.allSettled([maintenance.close(), notifications.close(), recovery.close(), closeCache()]);
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
