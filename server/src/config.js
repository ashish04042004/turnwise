import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

for (const candidate of ['../.env', '../../.env']) {
  const path = fileURLToPath(new URL(candidate, import.meta.url));
  if (existsSync(path)) {
    process.loadEnvFile(path);
    break;
  }
}

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (Number.isNaN(value)) throw new Error(`${name} must be a number`);
  return value;
}

function flag(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

const production = process.env.NODE_ENV === 'production';
if (production && !process.env.SESSION_SECRET) throw new Error('SESSION_SECRET must be set in production');

export const config = {
  production,
  /** Signs staff session cookies. The development fallback is public and must never be used for real data. */
  sessionSecret: process.env.SESSION_SECRET || 'turnwise-development-only-secret',
  sessionHours: num('SESSION_HOURS', 12),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://turnwise:turnwise@localhost:5433/turnwise',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6380',
  port: num('PORT', 4100),
  notifyFailureRate: num('NOTIFY_FAILURE_RATE', 0.15),
  enableSimulator: flag('ENABLE_SIMULATOR', true),
  /** Fixture loaded by `npm run seed` (path relative to server/). */
  seedFixture: process.env.SEED_FIXTURE ?? 'fixtures/demo.json',
  // Business behaviour (planning granularity, flags, simulator knobs) lives in
  // the setting_definitions / centre_settings tables, not here. This file only
  // holds deployment concerns.
  cache: {
    /** Share cached reads across processes through Redis; memory-only when off or when Redis is down. */
    redis: flag('CACHE_REDIS', true),
    /** Centre configuration and reference data; invalidated by database triggers, so this is only a backstop. */
    configSeconds: num('CACHE_CONFIG_SECONDS', 300),
    /** Signed-in staff lookups; invalidated when the staff row changes. */
    staffSeconds: num('CACHE_STAFF_SECONDS', 60),
    /** Live board; invalidated by every event, so this mainly coalesces bursts of refreshes. */
    boardSeconds: num('CACHE_BOARD_SECONDS', 2),
    analyticsSeconds: num('CACHE_ANALYTICS_SECONDS', 15),
    comparisonSeconds: num('CACHE_COMPARISON_SECONDS', 60),
    memoryEntries: num('CACHE_MEMORY_ENTRIES', 1000),
  },
  login: {
    maxFailures: num('LOGIN_MAX_FAILURES', 8),
    windowMin: num('LOGIN_WINDOW_MIN', 10),
  },
};
