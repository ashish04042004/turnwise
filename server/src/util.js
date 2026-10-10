import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function isMain(moduleUrl) {
  if (!process.argv[1]) return false;
  return resolve(fileURLToPath(moduleUrl)).toLowerCase() === resolve(process.argv[1]).toLowerCase();
}

export const MINUTE = 60_000;

export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}
