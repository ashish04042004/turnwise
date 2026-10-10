import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { config } from './config.js';
import { pool, withTx } from './db.js';
import { planSteps } from './domain/scheduler.js';
import { migrate } from './migrate.js';
import { newVisitSteps } from './services/context.js';
import { centreSpec, loadSyntheticNames, provisionCentre } from './services/provisioning.js';
import { peopleFrom, pickWeighted } from './services/synthetic.js';
import { isMain } from './util.js';

const MIN = 60_000;
const SERVER_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** How a demo day unfolds at a centre. Everything else about the centre is in its spec. */
const activitySpec = z
  .object({
    randomSeed: z.number().int().default(42),
    meanArrivalGapMin: z.number().positive().default(5),
    walkInShare: z.number().min(0).max(1).default(0.25),
    noShowShare: z.number().min(0).max(1).default(0.05),
    cancelShare: z.number().min(0).max(1).default(0.04),
    lateArrivalShare: z.number().min(0).max(1).default(0.2),
    maxInitialWaitMin: z.number().positive().default(45),
    waitlistSize: z.number().int().min(0).default(0),
  })
  .default({});

const fixtureSpec = z.object({
  syntheticNames: z.object({ first: z.array(z.string().min(1)).min(1), last: z.array(z.string().min(1)).min(1) }),
  centres: z.array(centreSpec.extend({ activity: activitySpec })).min(1),
});

export async function loadFixture(path = config.seedFixture) {
  const file = resolve(SERVER_ROOT, path);
  return fixtureSpec.parse(JSON.parse(await readFile(file, 'utf8')));
}

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
const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const toClock = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

/** The centre's normal hours, shifted when seeding outside them so the demo always has a past and a future. */
function demoHours(now, timezone, hours) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now));
  const minuteOfDay = Number(parts.find((p) => p.type === 'hour').value) * 60 + Number(parts.find((p) => p.type === 'minute').value);
  if (minuteOfDay >= toMinutes(hours.opens) + 60 && minuteOfDay <= toMinutes(hours.closes) - 120) return { ...hours, shifted: false };
  const open = Math.max(0, Math.floor((minuteOfDay - 180) / 60) * 60);
  const close = Math.min(23 * 60 + 59, minuteOfDay + 7 * 60);
  return { opens: toClock(open), closes: toClock(close), shifted: true };
}

/** A setting as the centre will see it: its override, else the definition's default. */
async function settingIn(tx, centreId, key) {
  const { rows } = await tx.query(
    `SELECT COALESCE((SELECT value FROM centre_settings WHERE centre_id = $1 AND key = $2), (SELECT default_value FROM setting_definitions WHERE key = $2)) AS value`,
    [centreId, key],
  );
  return rows[0].value;
}

/**
 * A plausible day so far at a provisioned centre: completed, in-service,
 * waiting and upcoming visits planned by the real scheduler (so they never
 * overlap), a few cancellations and no-shows, and a waitlist.
 */
async function generateActivity(tx, provisioned, activity, names, now) {
  const { centre, resources, services: byCode, spec } = provisioned;
  const rand = mulberry32(activity.randomSeed);
  const people = peopleFrom(names, await settingIn(tx, centre.id, 'sim_phone_prefix'));
  const granularity = (await settingIn(tx, centre.id, 'slot_granularity_min')) * MIN;
  const draw = (purpose) => pickWeighted(spec.demand[purpose], rand()).services;

  const { rows: win } = await tx.query(
    `SELECT (date_trunc('day', now() AT TIME ZONE $1) + $2::time) AT TIME ZONE $1 AS opens,
            (date_trunc('day', now() AT TIME ZONE $1) + $3::time) AT TIME ZONE $1 AS closes`,
    [centre.timezone, centre.opens_at, centre.closes_at],
  );
  const opensAt = win[0].opens.getTime();
  const closesAt = win[0].closes.getTime();

  const services = new Map([...byCode.values()].map((s) => [s.id, s]));
  const prereqs = new Map();
  for (const p of spec.prerequisites) {
    const row = { service_id: byCode.get(p.service).id, requires_service_id: byCode.get(p.requires).id, min_gap_min: p.minGapMin };
    prereqs.set(row.service_id, [...(prereqs.get(row.service_id) ?? []), row]);
  }
  const snap = { services, prereqs };

  let state = { horizonEnd: closesAt, granularityMs: granularity, resources, resourceBusy: new Map(), visitBusy: new Map(), fixedStepEnds: new Map() };
  const counts = { visits: 0, completed: 0, inService: 0, waiting: 0, upcoming: 0, cancelled: 0, noShow: 0, waitlist: 0 };

  const insertRes = (resourceId, stepId, status, start, end) =>
    tx.query(
      `INSERT INTO reservations (centre_id, resource_id, step_id, kind, status, during) VALUES ($1, $2, $3, 'service', $4, tstzrange($5, $6, '[)'))`,
      [centre.id, resourceId, stepId, status, new Date(start), new Date(end)],
    );
  const insertPatient = async (seed) =>
    (await tx.query(`INSERT INTO patients (centre_id, name, phone) VALUES ($1, $2, $3) RETURNING id, name`, [centre.id, people.name(seed), people.phone(seed)]))
      .rows[0];

  const hasWalkIns = spec.demand.walk_in.length > 0;
  let t = opensAt + 5 * MIN;
  let seq = 0;
  while (spec.demand.appointment.length && t < closesAt - 60 * MIN) {
    t += Math.round(-Math.log(1 - rand()) * activity.meanArrivalGapMin * MIN);
    seq++;
    const walkIn = rand() < activity.walkInShare && t < now && hasWalkIns;
    const requested = walkIn ? t : Math.ceil(t / granularity) * granularity;
    const codes = draw(walkIn ? 'walk_in' : 'appointment');
    const visitId = randomUUID();
    const seed = `${centre.id}-seed-${seq}`;
    const fate = rand();
    const pastSlot = requested < now - 20 * MIN;
    const outcome = !walkIn && pastSlot && fate < activity.noShowShare ? 'no_show' : !walkIn && fate > 1 - activity.cancelShare ? 'cancelled' : 'served';
    const patient = await insertPatient(seed);
    const steps = newVisitSteps(snap, { visitId, serviceIds: codes.map((c) => byCode.get(c).id), earliest: requested, priority: 0, label: patient.name });

    if (outcome !== 'served') {
      await tx.query(
        `INSERT INTO visits (id, centre_id, patient_id, kind, status, scheduled_at, cancelled_at, created_at) VALUES ($1, $2, $3, 'appointment', $4, $5, $6, $7)`,
        [visitId, centre.id, patient.id, outcome, new Date(requested), new Date(Math.min(now, requested)), new Date(opensAt - 86_400_000)],
      );
      for (const s of steps) await tx.query(`INSERT INTO visit_steps (id, visit_id, service_id, status) VALUES ($1, $2, $3, 'cancelled')`, [s.stepId, visitId, s.serviceId]);
      counts[outcome === 'no_show' ? 'noShow' : 'cancelled']++;
      counts.visits++;
      continue;
    }

    const plan = planSteps(steps, state);
    if (plan.unplaced.length || Math.min(...plan.placements.map((p) => p.start)) - requested > activity.maxInitialWaitMin * MIN) {
      await tx.query('DELETE FROM patients WHERE id = $1', [patient.id]);
      continue;
    }
    const firstStart = Math.min(...plan.placements.map((p) => p.start));

    const lateArrival = rand() < activity.lateArrivalShare;
    const arrivedAt = walkIn ? requested : requested + (lateArrival ? rand() * 12 : -rand() * 10) * MIN;
    const arrived = arrivedAt <= now && (walkIn || firstStart <= now + 15 * MIN);
    // Not here yet but already due: would be a no-show; keep the board tidy.
    if (!arrived && firstStart <= now) {
      await tx.query('DELETE FROM patients WHERE id = $1', [patient.id]);
      continue;
    }
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
        centre.id,
        patient.id,
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

  for (let i = 0; i < activity.waitlistSize && spec.demand.waitlist.length; i++) {
    const codes = spec.demand.waitlist[i % spec.demand.waitlist.length].services;
    const patient = await insertPatient(`${centre.id}-wait-${i}`);
    await tx.query(
      `INSERT INTO waitlist_entries (centre_id, patient_id, service_ids, earliest, latest, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'waiting', $6)`,
      [centre.id, patient.id, codes.map((c) => byCode.get(c).id), new Date(now), new Date(closesAt), new Date(now - (40 - i * 5) * MIN)],
    );
    counts.waitlist++;
  }

  await tx.query(`INSERT INTO events (centre_id, type, payload, actor) VALUES ($1, 'centre.seeded', $2, 'seed')`, [centre.id, JSON.stringify(counts)]);
  return counts;
}

/** Replaces every centre with the fixture's synthetic centres and a demo day at each. */
export async function seed({ quiet = false, fixture = config.seedFixture } = {}) {
  const log = quiet ? () => undefined : console.log;
  await migrate();
  const data = await loadFixture(fixture);

  return withTx(async (tx) => {
    await tx.query('TRUNCATE centres, synthetic_names CASCADE');
    await loadSyntheticNames(tx, data.syntheticNames);
    const now = (await tx.query('SELECT now() AS now')).rows[0].now.getTime();

    const seeded = [];
    for (const [i, { activity, ...spec }] of data.centres.entries()) {
      const hours = demoHours(now, spec.timezone, spec.hours);
      const provisioned = await provisionCentre(tx, { ...spec, hours: { opens: hours.opens, closes: hours.closes }, displayOrder: i });
      const counts = await generateActivity(tx, provisioned, activity, data.syntheticNames, now);
      seeded.push({ centreId: provisioned.centre.id, counts });

      log(`Seeded "${spec.name}" (${spec.city}) — hours ${hours.opens}–${hours.closes} ${spec.timezone}${hours.shifted ? ' (shifted so the demo has a past and a future)' : ''}`);
      log(`  ${provisioned.resources.length} resources, ${provisioned.services.size} services, ${counts.visits} visits today:`, counts);
      log(`  Staff sign-in: ${spec.staff.map((s) => `${s.name} (${s.role}) PIN ${s.pin}`).join(' · ')}`);
    }
    return { centres: seeded, centreId: seeded[0].centreId, counts: seeded[0].counts };
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
