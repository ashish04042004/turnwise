import { randomUUID } from 'node:crypto';
import { pool, withTx } from './db.js';
import { migrate } from './migrate.js';
import { planSteps } from './domain/scheduler.js';
import { newVisitSteps, resetCentreCache } from './services/context.js';
import { syntheticName, syntheticPhone } from './services/simulator.js';
import { isMain } from './util.js';

const TZ = 'Asia/Kolkata';
const MIN = 60_000;

const RESOURCES = [
  ['Collection Bay 1', 'room', ['blood_collection']],
  ['Collection Bay 2', 'room', ['blood_collection']],
  ['Ritu (Phlebotomist)', 'staff', ['phlebotomist']],
  ['Imran (Phlebotomist)', 'staff', ['phlebotomist']],
  ['ECG Machine', 'equipment', ['ecg']],
  ['Meena (Cardiac Tech)', 'staff', ['ecg_tech']],
  ['USG Room 1', 'equipment', ['ultrasound']],
  ['USG Room 2', 'equipment', ['ultrasound']],
  ['Dr. Kapoor (Radiologist)', 'staff', ['radiologist']],
  ['Dr. Iyer (Radiologist)', 'staff', ['radiologist']],
  ['X-Ray Unit', 'equipment', ['xray']],
  ['Sunil (Radiographer)', 'staff', ['radiographer']],
];

const SERVICES = [
  ['CBC', 'Complete blood count', 'pathology', 10, ['blood_collection', 'phlebotomist']],
  ['LFT', 'Liver function test', 'pathology', 10, ['blood_collection', 'phlebotomist']],
  ['LIPID', 'Lipid profile', 'pathology', 10, ['blood_collection', 'phlebotomist']],
  ['TSH', 'Thyroid stimulating hormone', 'pathology', 10, ['blood_collection', 'phlebotomist']],
  ['HBA1C', 'HbA1c', 'pathology', 5, ['blood_collection', 'phlebotomist']],
  ['FBS', 'Fasting blood sugar', 'pathology', 5, ['blood_collection', 'phlebotomist']],
  ['PPBS', 'Post-prandial blood sugar', 'pathology', 5, ['blood_collection', 'phlebotomist']],
  ['ECG', 'Electrocardiogram', 'cardiology', 15, ['ecg', 'ecg_tech']],
  ['USG_ABD', 'Ultrasound — whole abdomen', 'imaging', 20, ['ultrasound', 'radiologist']],
  ['USG_PELVIS', 'Ultrasound — pelvis', 'imaging', 20, ['ultrasound', 'radiologist']],
  ['XRAY_CHEST', 'Chest X-ray', 'imaging', 10, ['xray', 'radiographer']],
];

const MIXES = [
  [0.14, ['CBC']],
  [0.1, ['CBC', 'LFT', 'LIPID']],
  [0.06, ['FBS', 'PPBS']],
  [0.13, ['USG_ABD']],
  [0.07, ['USG_PELVIS']],
  [0.1, ['ECG']],
  [0.08, ['ECG', 'CBC']],
  [0.1, ['XRAY_CHEST']],
  [0.08, ['USG_ABD', 'CBC', 'LFT']],
  [0.14, ['TSH', 'HBA1C']],
];

function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n) => String(n).padStart(2, '0');

/** Normal 07:00–21:00 hours, shifted when run at night so the demo always has a past and a future. */
function chooseHours(now) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now));
  const h = Number(parts.find((p) => p.type === 'hour').value);
  const m = Number(parts.find((p) => p.type === 'minute').value);
  const minuteOfDay = h * 60 + m;
  if (minuteOfDay >= 8 * 60 && minuteOfDay <= 19 * 60) return { opens: '07:00', closes: '21:00', shifted: false };
  const open = Math.max(0, Math.floor((minuteOfDay - 180) / 60) * 60);
  const close = Math.min(23 * 60 + 59, minuteOfDay + 7 * 60);
  return { opens: `${pad(Math.floor(open / 60))}:${pad(open % 60)}`, closes: `${pad(Math.floor(close / 60))}:${pad(close % 60)}`, shifted: true };
}

export async function seed({ quiet = false } = {}) {
  const log = quiet ? () => undefined : console.log;
  await migrate();
  const rand = mulberry32(42);
  const pickMix = () => {
    let r = rand();
    for (const [p, mix] of MIXES) if ((r -= p) <= 0) return mix;
    return MIXES[0][1];
  };

  return withTx(async (tx) => {
    await tx.query('TRUNCATE centres CASCADE');
    resetCentreCache();
    const now = (await tx.query('SELECT now() AS now')).rows[0].now.getTime();
    const hours = chooseHours(now);

    const { rows: centreRows } = await tx.query(
      `INSERT INTO centres (name, city, timezone, opens_at, closes_at, hold_ttl_seconds, offer_ttl_seconds, offer_lead_minutes)
       VALUES ('Sector 18 Diagnostics', 'Noida', $1, $2, $3, 120, 600, 20) RETURNING id`,
      [TZ, hours.opens, hours.closes],
    );
    const centreId = centreRows[0].id;
    const { rows: win } = await tx.query(
      `SELECT (date_trunc('day', now() AT TIME ZONE $1) + $2::time) AT TIME ZONE $1 AS opens,
              (date_trunc('day', now() AT TIME ZONE $1) + $3::time) AT TIME ZONE $1 AS closes`,
      [TZ, hours.opens, hours.closes],
    );
    const opensAt = win[0].opens.getTime();
    const closesAt = win[0].closes.getTime();

    const resources = [];
    for (const [i, [name, kind, caps]] of RESOURCES.entries()) {
      const { rows } = await tx.query(
        `INSERT INTO resources (centre_id, name, kind, capabilities, sort_order) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, capabilities, active`,
        [centreId, name, kind, caps, i],
      );
      resources.push(rows[0]);
    }
    const services = new Map();
    const byCode = new Map();
    for (const [code, name, category, duration, reqs] of SERVICES) {
      const { rows } = await tx.query(
        `INSERT INTO services (centre_id, code, name, category, duration_min, requirements) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [centreId, code, name, category, duration, reqs],
      );
      services.set(rows[0].id, rows[0]);
      byCode.set(code, rows[0]);
    }
    await tx.query(`INSERT INTO service_prerequisites (service_id, requires_service_id, min_gap_min) VALUES ($1, $2, 120)`, [
      byCode.get('PPBS').id,
      byCode.get('FBS').id,
    ]);
    const prereqs = new Map([[byCode.get('PPBS').id, [{ service_id: byCode.get('PPBS').id, requires_service_id: byCode.get('FBS').id, min_gap_min: 120 }]]]);
    const snap = { services, prereqs };

    let state = { horizonEnd: closesAt, granularityMs: 5 * MIN, resources, resourceBusy: new Map(), visitBusy: new Map(), fixedStepEnds: new Map() };
    const counts = { visits: 0, completed: 0, inService: 0, waiting: 0, upcoming: 0, cancelled: 0, noShow: 0 };

    const insertRes = (resourceId, stepId, status, start, end) =>
      tx.query(
        `INSERT INTO reservations (centre_id, resource_id, step_id, kind, status, during) VALUES ($1, $2, $3, 'service', $4, tstzrange($5, $6, '[)'))`,
        [centreId, resourceId, stepId, status, new Date(start), new Date(end)],
      );

    let t = opensAt + 5 * MIN;
    let seq = 0;
    while (t < closesAt - 60 * MIN) {
      t += Math.round(-Math.log(1 - rand()) * 5 * MIN);
      seq++;
      const walkIn = rand() < 0.25 && t < now;
      const requested = walkIn ? t : Math.ceil(t / (5 * MIN)) * 5 * MIN;
      const mix = pickMix();
      const visitId = randomUUID();
      const name = syntheticName(`seed-${seq}`);
      const steps = newVisitSteps(snap, { visitId, serviceIds: mix.map((c) => byCode.get(c).id), earliest: requested, priority: 0, label: name });

      const fate = rand();
      const pastSlot = requested < now - 20 * MIN;
      const outcome = !walkIn && pastSlot && fate < 0.05 ? 'no_show' : !walkIn && fate > 0.96 ? 'cancelled' : 'served';

      const { rows: pat } = await tx.query(`INSERT INTO patients (centre_id, name, phone) VALUES ($1, $2, $3) RETURNING id`, [
        centreId,
        name,
        syntheticPhone(`seed-${seq}`),
      ]);

      if (outcome !== 'served') {
        await tx.query(
          `INSERT INTO visits (id, centre_id, patient_id, kind, status, scheduled_at, cancelled_at, created_at) VALUES ($1, $2, $3, 'appointment', $4, $5, $6, $7)`,
          [visitId, centreId, pat[0].id, outcome, new Date(requested), new Date(Math.min(now, requested)), new Date(opensAt - 86_400_000)],
        );
        for (const s of steps) await tx.query(`INSERT INTO visit_steps (id, visit_id, service_id, status) VALUES ($1, $2, $3, 'cancelled')`, [s.stepId, visitId, s.serviceId]);
        counts[outcome === 'no_show' ? 'noShow' : 'cancelled']++;
        counts.visits++;
        continue;
      }

      const plan = planSteps(steps, state);
      if (plan.unplaced.length || Math.min(...plan.placements.map((p) => p.start)) - requested > 45 * MIN) continue;
      const firstStart = Math.min(...plan.placements.map((p) => p.start));

      const lateArrival = rand() < 0.2;
      const arrivedAt = walkIn ? requested : requested + (lateArrival ? rand() * 12 : -rand() * 10) * MIN;
      const arrived = arrivedAt <= now && (walkIn || firstStart <= now + 15 * MIN);
      // Not here yet but already due: would be a no-show; keep the board tidy.
      if (!arrived && firstStart <= now) continue;
      state = plan.state;

      let anyInService = false;
      let allDone = true;
      const placements = [...plan.placements].sort((a, b) => a.start - b.start);
      const stepRows = [];
      let cursor = arrivedAt;
      for (const p of placements) {
        const svc = services.get(steps.find((s) => s.stepId === p.stepId).serviceId);
        if (arrived && p.end <= now) {
          const start = Math.max(p.start + rand() * 6 * MIN, cursor);
          const end = Math.min(now - MIN, start + svc.duration_min * (0.85 + rand() * 0.55) * MIN);
          cursor = end;
          stepRows.push({ p, status: 'completed', actualStart: start, actualEnd: Math.max(end, start + MIN) });
        } else if (arrived && p.start <= now) {
          anyInService = true;
          allDone = false;
          stepRows.push({ p, status: 'in_service', actualStart: p.start });
        } else {
          allDone = false;
          stepRows.push({ p, status: 'scheduled' });
        }
      }
      const status = !arrived ? 'booked' : allDone ? 'completed' : anyInService ? 'in_progress' : 'arrived';
      await tx.query(
        `INSERT INTO visits (id, centre_id, patient_id, kind, status, scheduled_at, arrived_at, completed_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          visitId,
          centreId,
          pat[0].id,
          walkIn ? 'walk_in' : 'appointment',
          status,
          walkIn ? null : new Date(requested),
          arrived ? new Date(arrivedAt) : null,
          allDone && arrived ? new Date(Math.max(...stepRows.map((r) => r.actualEnd))) : null,
          new Date(walkIn ? requested : opensAt - 86_400_000),
        ],
      );
      for (const r of stepRows) {
        const s = steps.find((x) => x.stepId === r.p.stepId);
        await tx.query(
          `INSERT INTO visit_steps (id, visit_id, service_id, status, planned, original_start, actual_start, actual_end, version)
           VALUES ($1, $2, $3, $4, tstzrange($5, $6, '[)'), $5, $7, $8, 1)`,
          [s.stepId, visitId, s.serviceId, r.status, new Date(r.p.start), new Date(r.p.end), r.actualStart ? new Date(r.actualStart) : null, r.actualEnd ? new Date(r.actualEnd) : null],
        );
        for (const rid of r.p.resourceIds) {
          if (r.status === 'completed') await insertRes(rid, s.stepId, 'completed', r.actualStart, r.actualEnd);
          else await insertRes(rid, s.stepId, r.status === 'in_service' ? 'in_use' : 'confirmed', r.p.start, r.p.end);
        }
        if (arrived) {
          await tx.query(`INSERT INTO estimate_snapshots (step_id, predicted_start, made_at, source) VALUES ($1, $2, $3, $4)`, [
            s.stepId,
            new Date(r.p.start),
            new Date(arrivedAt),
            walkIn ? 'walk_in' : 'check_in',
          ]);
        }
      }
      counts.visits++;
      if (status === 'completed') counts.completed++;
      else if (status === 'in_progress') counts.inService++;
      else if (status === 'arrived') counts.waiting++;
      else counts.upcoming++;
    }

    const waitlist = [
      ['USG_ABD'],
      ['ECG'],
      ['CBC', 'LFT'],
      ['USG_PELVIS'],
    ];
    for (const [i, codes] of waitlist.entries()) {
      const { rows: pat } = await tx.query(`INSERT INTO patients (centre_id, name, phone) VALUES ($1, $2, $3) RETURNING id`, [
        centreId,
        syntheticName(`wait-${i}`),
        syntheticPhone(`wait-${i}`),
      ]);
      await tx.query(
        `INSERT INTO waitlist_entries (centre_id, patient_id, service_ids, earliest, latest, status, created_at)
         VALUES ($1, $2, $3, $4, $5, 'waiting', $6)`,
        [centreId, pat[0].id, codes.map((c) => byCode.get(c).id), new Date(now), new Date(closesAt), new Date(now - (40 - i * 5) * MIN)],
      );
    }

    await tx.query(`INSERT INTO events (centre_id, type, payload, actor) VALUES ($1, 'centre.seeded', $2, 'seed')`, [centreId, JSON.stringify(counts)]);
    log(`Seeded "Sector 18 Diagnostics" (Noida) — hours ${hours.opens}–${hours.closes} IST${hours.shifted ? ' (shifted so the demo has a past and a future)' : ''}`);
    log(`  ${resources.length} resources, ${services.size} services, ${counts.visits} visits today:`, counts);
    log(`  ${waitlist.length} patients on the waitlist`);
    return { centreId, counts };
  });
}

if (isMain(import.meta.url)) {
  seed()
    .then(() => pool.end())
    .catch(async (err) => {
      console.error(err);
      await pool.end();
      process.exit(1);
    });
}
