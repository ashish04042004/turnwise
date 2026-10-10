/**
 * Two-tier read cache. Process memory absorbs bursts (every dashboard
 * refetching after an event); Redis shares results across API replicas and
 * the worker. Redis is optional: when it is off or unreachable, reads fall
 * back to memory and Postgres, and nothing breaks.
 *
 * Only reference data and read models are cached. Anything a booking decision
 * depends on (reservations, steps, live resource state) is read from Postgres
 * inside the transaction that acts on it, so a stale cache can never cause a
 * double booking.
 *
 * Invalidation: database triggers NOTIFY on every reference-data change
 * (see invalidation.js), and code that changes data invalidates directly so
 * the same process never serves its own stale write.
 */
import { Redis } from 'ioredis';
import { config } from './config.js';

// Bump the version whenever a cached value changes shape, so a deploy never reads entries the previous release wrote.
const PREFIX = 'tw:v2:cache:';
const COUNTER_PREFIX = 'tw:v1:count:';
const REDIS_RETRY_MS = 5000;

/** Builders for every cache key, so invalidation and reads always agree. */
export const keys = {
  reference: () => 'reference',
  centre: (centreId) => `centre:${centreId}`,
  defaultCentre: () => 'centre:default',
  centreList: () => 'centres',
  staff: (staffId) => `staff:${staffId}`,
  user: (userId) => `user:${userId}`,
  board: (centreId) => `board:${centreId}`,
  analytics: (centreId) => `analytics:${centreId}`,
  comparison: (centreId) => `comparison:${centreId}`,
};

const memory = new Map();
const inflight = new Map();
let redis = null;
let redisDownUntil = 0;

function redisClient() {
  if (!config.cache.redis || Date.now() < redisDownUntil) return null;
  if (!redis) {
    redis = new Redis(config.redisUrl, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 1000,
      retryStrategy: (attempt) => Math.min(attempt * 500, REDIS_RETRY_MS),
    });
    redis.on('error', () => undefined);
  }
  return redis;
}

/**
 * The client once it can take commands. A process's first use waits briefly
 * for the initial connection, so an early invalidation is not silently
 * skipped and left stale in Redis; a client that lost its connection is
 * treated as down until it reconnects.
 */
async function readyClient() {
  const client = redisClient();
  if (!client || client.status === 'ready') return client;
  if (client.status !== 'connecting' && client.status !== 'connect') return null;
  return new Promise((resolve) => {
    const finish = (ok) => {
      clearTimeout(timer);
      client.off('ready', onReady);
      resolve(ok ? client : null);
    };
    const onReady = () => finish(true);
    const timer = setTimeout(() => finish(false), 1000);
    client.once('ready', onReady);
  });
}

async function viaRedis(fn) {
  const client = await readyClient();
  if (!client) return undefined;
  try {
    return await fn(client);
  } catch {
    redisDownUntil = Date.now() + REDIS_RETRY_MS;
    return undefined;
  }
}

/** Plain JSON (no Date instances, no shared references), so both tiers return the same shape. */
const normalise = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}
// Cached values are shared; freezing them outside production turns accidental mutation into a test failure.
const seal = config.production ? (v) => v : deepFreeze;

function remember(key, value, ttlSec) {
  if (memory.size >= config.cache.memoryEntries) memory.delete(memory.keys().next().value);
  memory.set(key, { value, expires: Date.now() + ttlSec * 1000 });
}

// Bumped on every invalidation, so a load that started before it is returned to its caller but never stored.
const generations = new Map();
const generationOf = (key) => generations.get(key) ?? 0;
function bump(key) {
  generations.set(key, generationOf(key) + 1);
  memory.delete(key);
  inflight.delete(key);
}

/** Returns the cached value for `key`, loading it once (per process) on a miss. */
export async function cached(key, ttlSec, load) {
  const hit = memory.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  if (inflight.has(key)) return inflight.get(key);

  const generation = generationOf(key);
  const current = () => generationOf(key) === generation;
  const promise = (async () => {
    const shared = await viaRedis((r) => r.get(PREFIX + key));
    let value;
    if (shared != null) {
      value = JSON.parse(shared);
    } else {
      value = normalise(await load());
      if (current()) await viaRedis((r) => r.set(PREFIX + key, JSON.stringify(value), 'EX', Math.max(1, Math.ceil(ttlSec))));
    }
    seal(value);
    if (current()) remember(key, value, ttlSec);
    return value;
  })();
  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    if (inflight.get(key) === promise) inflight.delete(key);
  }
}

/** Drops keys everywhere: this process's memory and the shared Redis tier. */
export async function invalidate(...cacheKeys) {
  for (const k of cacheKeys) bump(k);
  if (cacheKeys.length) await viaRedis((r) => r.del(...cacheKeys.map((k) => PREFIX + k)));
}

/** Drops keys from this process only (other processes hear the same notification and do the same). */
export function invalidateLocal(match) {
  for (const k of new Set([...memory.keys(), ...inflight.keys()])) if (match(k)) bump(k);
}

/** Drops every cached value in this process and in Redis (rate-limit counters are kept). */
export async function invalidateAll() {
  invalidateLocal(() => true);
  await viaRedis(async (r) => {
    let cursor = '0';
    do {
      const [next, found] = await r.scan(cursor, 'MATCH', `${PREFIX}*`, 'COUNT', 500);
      if (found.length) await r.del(...found);
      cursor = next;
    } while (cursor !== '0');
  });
}

/** Everything cached about a centre: its configuration and its read models. */
export const centreKeys = (centreId) => [keys.centre(centreId), keys.board(centreId), keys.analytics(centreId), keys.comparison(centreId)];

/**
 * Counts hits on `key` within a rolling window (fixed window from the first
 * hit). Shared through Redis so limits hold across API replicas.
 */
const counters = new Map();
export async function countHit(key, windowSec) {
  const shared = await viaRedis(async (r) => {
    const [[, n]] = await r.multi().incr(COUNTER_PREFIX + key).expire(COUNTER_PREFIX + key, windowSec, 'NX').exec();
    return n;
  });
  if (shared !== undefined) return shared;
  const entry = counters.get(key);
  if (!entry || entry.resetAt <= Date.now()) {
    counters.set(key, { n: 1, resetAt: Date.now() + windowSec * 1000 });
    return 1;
  }
  return ++entry.n;
}

export async function peekCount(key) {
  const shared = await viaRedis((r) => r.get(COUNTER_PREFIX + key));
  if (shared !== undefined) return Number(shared ?? 0);
  const entry = counters.get(key);
  return entry && entry.resetAt > Date.now() ? entry.n : 0;
}

export async function resetCount(key) {
  counters.delete(key);
  await viaRedis((r) => r.del(COUNTER_PREFIX + key));
}

export async function closeCache() {
  memory.clear();
  if (redis) await redis.quit().catch(() => undefined);
  redis = null;
}
