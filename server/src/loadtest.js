/**
 * Synthetic contention benchmark on an isolated, temporary centre:
 * many concurrent clients race for a small set of slots, then we check that
 * no resource was ever double-booked and report latency percentiles.
 *
 *   npm run loadtest -- --clients 50 --attempts 400 --slots 20
 */
import { parseArgs } from 'node:util';
import { pool } from './db.js';
import { migrate } from './migrate.js';
import { createHold, createWalkIn } from './services/booking.js';
import { getCentre } from './services/context.js';
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
  const { rows } = await pool.query(
    `INSERT INTO centres (name, city, timezone, opens_at, closes_at) VALUES ('Load Test Centre', 'Bench', $1, '00:00', '23:59') RETURNING id`,
    [offset],
  );
  const centre = await getCentre(pool, rows[0].id);
  try {
    for (const [name, caps] of [
      ['Machine 1', ['scan']],
      ['Machine 2', ['scan']],
      ['Operator 1', ['operator']],
      ['Operator 2', ['operator']],
    ]) {
      await pool.query(`INSERT INTO resources (centre_id, name, kind, capabilities) VALUES ($1, $2, 'equipment', $3)`, [centre.id, name, caps]);
    }
    const svc = (
      await pool.query(
        `INSERT INTO services (centre_id, code, name, category, duration_min, requirements) VALUES ($1, 'SCAN', 'Scan', 'bench', 15, '{scan,operator}') RETURNING id`,
        [centre.id],
      )
    ).rows[0].id;

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
    if (overlap[0].n > 0) process.exitCode = 1;
  } finally {
    await pool.query('DELETE FROM visits WHERE centre_id = $1', [centre.id]);
    await pool.query('DELETE FROM reservations WHERE centre_id = $1', [centre.id]);
    await pool.query('DELETE FROM centres WHERE id = $1', [centre.id]);
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
