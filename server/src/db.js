import pg from 'pg';
import { config } from './config.js';

pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10)); // int8 / bigserial
pg.types.setTypeParser(1700, (v) => Number.parseFloat(v)); // numeric

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 30 });

export async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Serializes plan-then-commit work for one centre (held until the transaction
 * ends), so concurrent planners queue up instead of computing the same slot
 * and retrying. Exclusion constraints still guarantee correctness on their own.
 */
export async function lockCentrePlanning(tx, centreId) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`plan:${centreId}`]);
}

/**
 * This transaction lost a race for capacity: an exclusion constraint rejected
 * an overlap (23P01), or concurrent conflicting inserts deadlocked on the
 * exclusion index (40P01), or a serialization failure (40001). In every case
 * nothing was committed and the operation can be re-planned.
 */
export function isCapacityConflict(err) {
  return ['23P01', '40P01', '40001'].includes(err?.code);
}

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const conflict = (message, details) => new HttpError(409, 'conflict', message, details);
export const notFound = (what) => new HttpError(404, 'not_found', `${what} not found`);
export const badRequest = (message) => new HttpError(400, 'bad_request', message);

/**
 * Runs an optimistic plan-then-commit operation, retrying when a concurrent
 * writer claimed the same capacity first. The database constraint is the arbiter.
 */
export async function retryOnConflict(fn, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!isCapacityConflict(err)) throw err;
      lastErr = err;
      await new Promise((r) => setTimeout(r, 5 + Math.random() * 20 * (i + 1)));
    }
  }
  throw conflict('Capacity changed while planning; please retry', { cause: String(lastErr) });
}
