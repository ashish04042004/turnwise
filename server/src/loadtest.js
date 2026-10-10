/**
 * Synthetic contention benchmark on an isolated, temporary centre:
 * many concurrent clients race for a small set of slots, then we check that
 * no resource was ever double-booked and report latency percentiles.
 *
 *   npm run loadtest -- --clients 50 --attempts 400 --slots 20
 */
import { parseArgs } from 'node:util';
import { closeCache } from './cache.js';
import { pool } from './db.js';
import { migrate } from './migrate.js';
import { createHold, createWalkIn } from './services/booking.js';
import { getCentre } from './services/context.js';
import { provisionCentre } from './services/provisioning.js';
import { percentile } from './util.js';

const { values } = parseArgs({
  options: {
    clients: { type: 'string', default: '50' },
    attempts: { type: 'string', default: '400' },
    slots: { type: 'string', default: '20' },
    walkins: { type: 'string', default: '60' },
  },
});
const CLIENTS = Number(values.clients);
const ATTEMPTS = Number(values.attempts);
const SLOTS = Number(values.slots);
const WALKINS = Number(values.walkins);
const MIN = 60_000;

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, p50: +percentile(s, 50)?.toFixed(1), p95: +percentile(s, 95)?.toFixed(1), max: +s.at(-1)?.toFixed(1) };
};

async function main() {
  await migrate();
  const offset = (() => {
    let o = 10 - new Date().getUTCHours();
    if (o < -12) o += 24;
    if (o > 14) o -= 24;
    return o >= 0 ? `Etc/GMT-${o}` : `Etc/GMT+${-o}`;
  })();
  const provisioned = await provisionCentre(pool, {
    name: 'Load Test Centre',
    city: 'Bench',
    timezone: offset,
    hours: { opens: '00:00', closes: '23:59' },
    displayOrder: 1000,
    resources: [
      { name: 'Machine 1', kind: 'equipment', capabilities: ['scan'] },
      { name: 'Machine 2', kind: 'equipment', capabilities: ['scan'] },
      { name: 'Operator 1', kind: 'staff', capabilities: ['operator'] },
      { name: 'Operator 2', kind: 'staff', capabilities: ['operator'] },
    ],
    services: [{ code: 'SCAN', name: 'Scan', category: 'bench', durationMin: 15, requirements: ['scan', 'operator'] }],
  });
  const centre = await getCentre(provisioned.centre.id);
  try {
    const svc = provisioned.services.get('SCAN').id;

    const now = (await pool.query('SELECT now() AS now')).rows[0].now.getTime();
    const base = Math.ceil((now + 30 * MIN) / (5 * MIN)) * 5 * MIN;
    const slots = Array.from({ length: SLOTS }, (_, i) => new Date(base + i * 15 * MIN));

    const holdLatency = [];
    const outcomes = { won: 0, conflict: 0, other: 0 };
    let next = 0;
    const started = Date.now();
    await Promise.all(
      Array.from({ length: CLIENTS }, async (_, c) => {
        while (next < ATTEMPTS) {
          const i = next++;
          const t0 = performance.now();
          try {
            await createHold(centre, { patient: { name: `Bench ${c}-${i}` }, serviceIds: [svc], start: slots[i % SLOTS] }, 'bench');
            outcomes.won++;
          } catch (err) {
            if (err.status === 409) outcomes.conflict++;
            else {
              outcomes.other++;
              console.error(err);
            }
          }
          holdLatency.push(performance.now() - t0);
        }
      }),
    );
    const holdSeconds = (Date.now() - started) / 1000;

    const walkLatency = [];
    let walkFailed = 0;
    await Promise.all(
      Array.from({ length: WALKINS }, async (_, i) => {
        const t0 = performance.now();
        try {
          await createWalkIn(centre, { patient: { name: `Walk ${i}` }, serviceIds: [svc] }, 'bench');
        } catch {
          walkFailed++;
        }
        walkLatency.push(performance.now() - t0);
      }),
    );

    const { rows: overlap } = await pool.query(
      `SELECT count(*)::int AS n FROM reservations a JOIN reservations b
         ON a.resource_id = b.resource_id AND a.id < b.id AND a.during && b.during
       WHERE a.centre_id = $1 AND a.status IN ('held', 'confirmed', 'in_use') AND b.status IN ('held', 'confirmed', 'in_use')`,
      [centre.id],
    );

    const report = {
      config: { clients: CLIENTS, holdAttempts: ATTEMPTS, contestedSlots: SLOTS, resourcesPerSlot: 2, concurrentWalkIns: WALKINS },
      holds: { ...outcomes, maxPossibleWinners: SLOTS * 2, throughputPerSec: +(ATTEMPTS / holdSeconds).toFixed(1), latencyMs: stats(holdLatency) },
      walkIns: { placed: WALKINS - walkFailed, failed: walkFailed, latencyMs: stats(walkLatency) },
      doubleBookings: overlap[0].n,
    };
    console.log(JSON.stringify(report, null, 2));
    if (overlap[0].n > 0 || outcomes.other > 0 || walkFailed > 0) process.exitCode = 1;
  } finally {
    await pool.query('DELETE FROM visits WHERE centre_id = $1', [centre.id]);
    await pool.query('DELETE FROM reservations WHERE centre_id = $1', [centre.id]);
    await pool.query('DELETE FROM centres WHERE id = $1', [centre.id]);
    await closeCache();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
