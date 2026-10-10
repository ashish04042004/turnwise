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

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://turnwise:turnwise@localhost:5433/turnwise',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6380',
  port: num('PORT', 4100),
  notifyFailureRate: num('NOTIFY_FAILURE_RATE', 0.15),
  enableSimulator: (process.env.ENABLE_SIMULATOR ?? 'true') === 'true',
  /** Planner time granularity; candidate starts are rounded up to this. */
  slotGranularityMin: 5,
  /** Overruns shorter than this only show as projected delay; longer ones extend the reservation. */
  overrunGraceMin: num('OVERRUN_GRACE_MIN', 5),
};
