import { percentile } from './util.js';

const WINDOW = 2000;
const samples = new Map();

/** Express middleware: records per-route latency in a bounded in-memory window. */
export function latencyMiddleware(req, res, next) {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    if (!req.route) return;
    const key = `${req.method} ${req.baseUrl}${req.route.path}`;
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const list = samples.get(key) ?? [];
    list.push(ms);
    if (list.length > WINDOW) list.shift();
    samples.set(key, list);
  });
  next();
}

export function latencySummary() {
  return [...samples]
    .map(([route, list]) => {
      const sorted = [...list].sort((a, b) => a - b);
      return {
        route,
        count: sorted.length,
        p50: Math.round(percentile(sorted, 50) * 10) / 10,
        p95: Math.round(percentile(sorted, 95) * 10) / 10,
      };
    })
    .sort((a, b) => b.count - a.count);
}
