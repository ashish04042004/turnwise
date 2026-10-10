import { createHash } from 'node:crypto';
import { pool } from '../db.js';
import { getCentre } from './context.js';
import { createWalkIn, releaseVisit } from './booking.js';
import { checkIn, completeStep, extendStep, startStep } from './operations.js';
import { markResourceDown } from './replan.js';

/** Deterministic pseudo-random in [0, 1) so the same patient behaves the same on every tick. */
export const unit = (key) => createHash('sha1').update(key).digest().readUInt32BE(0) / 2 ** 32;

const FIRST = ['Aarav', 'Ananya', 'Rohan', 'Priya', 'Vikram', 'Neha', 'Arjun', 'Kavya', 'Rahul', 'Isha', 'Sanjay', 'Pooja', 'Amit', 'Sneha', 'Karan', 'Meera', 'Deepak', 'Ritu', 'Nikhil', 'Divya', 'Suresh', 'Anjali', 'Manoj', 'Tanvi'];
const LAST = ['Sharma', 'Verma', 'Gupta', 'Singh', 'Agarwal', 'Mehta', 'Kapoor', 'Jain', 'Malhotra', 'Bansal', 'Chauhan', 'Yadav', 'Saxena', 'Arora', 'Bhatia', 'Mishra'];

export function syntheticName(seed = Math.random().toString()) {
  return `${FIRST[Math.floor(unit(`f${seed}`) * FIRST.length)]} ${LAST[Math.floor(unit(`l${seed}`) * LAST.length)]}`;
}

export const syntheticPhone = (seed = Math.random().toString()) => `+91 9${String(Math.floor(unit(`p${seed}`) * 1e9)).padStart(9, '0')}`;

/**
 * One step of the floor autopilot: patients arrive (some late, some never),
 * due services start when their resources free up, and services finish after
 * a realistic, sometimes overrunning, duration.
 */
export async function simTick(centreId) {
  const centre = await getCentre(pool, centreId);
  const actions = [];
  const attempt = async (label, fn) => {
    try {
      await fn();
      actions.push(label);
    } catch (err) {
      if (err.status !== 409 && err.status !== 410) throw err;
    }
  };

  const { rows: due } = await pool.query(
    `SELECT v.id, p.name, v.scheduled_at, now() AS now FROM visits v JOIN patients p ON p.id = v.patient_id
     WHERE v.centre_id = $1 AND v.status = 'booked' AND v.scheduled_at <= now() + interval '15 minutes'`,
    [centre.id],
  );
  for (const v of due) {
    const r = unit(`arrive${v.id}`);
    if (r > 0.92) continue; // never shows up
    const offsetMin = r < 0.7 ? -10 * unit(`early${v.id}`) : 15 * unit(`late${v.id}`);
    if (v.now.getTime() >= v.scheduled_at.getTime() + offsetMin * 60_000) await attempt(`${v.name} checked in`, () => checkIn(centre, v.id, 'simulator'));
  }

  const { rows: running } = await pool.query(
    `SELECT s.id, s.actual_start, sv.duration_min, sv.code, p.name, now() AS now
     FROM visit_steps s JOIN visits v ON v.id = s.visit_id JOIN services sv ON sv.id = s.service_id JOIN patients p ON p.id = v.patient_id
     WHERE v.centre_id = $1 AND s.status = 'in_service'`,
    [centre.id],
  );
  for (const s of running) {
    const factor = 0.8 + 0.7 * unit(`dur${s.id}`);
    if (s.now.getTime() >= s.actual_start.getTime() + s.duration_min * factor * 60_000) {
      await attempt(`${s.name} finished ${s.code}`, () => completeStep(centre, s.id, 'simulator'));
    }
  }

  const { rows: ready } = await pool.query(
    `SELECT s.id, sv.code, p.name FROM visit_steps s JOIN visits v ON v.id = s.visit_id
     JOIN services sv ON sv.id = s.service_id JOIN patients p ON p.id = v.patient_id
     WHERE v.centre_id = $1 AND s.status = 'scheduled' AND v.status IN ('arrived', 'in_progress')
       AND lower(s.planned) <= now() + interval '1 minute'
     ORDER BY lower(s.planned)`,
    [centre.id],
  );
  for (const s of ready) await attempt(`${s.name} started ${s.code}`, () => startStep(centre, s.id, {}, 'simulator'));

  return { actions };
}

const WALK_IN_MIXES = [['CBC'], ['CBC', 'LFT'], ['FBS', 'LIPID'], ['ECG'], ['CBC', 'ECG'], ['XRAY_CHEST'], ['TSH', 'CBC'], ['USG_ABD']];

export async function simWalkInRush(centreId, count = 3) {
  const centre = await getCentre(pool, centreId);
  const { rows: services } = await pool.query(`SELECT id, code FROM services WHERE centre_id = $1`, [centre.id]);
  const byCode = new Map(services.map((s) => [s.code, s.id]));
  // Fired concurrently on purpose: the reservation engine must arbitrate.
  const results = await Promise.allSettled(
    Array.from({ length: count }, (_, i) => {
      const seed = `${Date.now()}-${i}`;
      const mix = WALK_IN_MIXES[Math.floor(unit(`mix${seed}`) * WALK_IN_MIXES.length)].filter((c) => byCode.has(c));
      return createWalkIn(centre, { patient: { name: syntheticName(seed), phone: syntheticPhone(seed) }, serviceIds: mix.map((c) => byCode.get(c)) }, 'simulator');
    }),
  );
  return {
    created: results.filter((r) => r.status === 'fulfilled').length,
    failed: results.filter((r) => r.status === 'rejected').map((r) => r.reason.message),
  };
}

export async function simBreakdown(centreId, minutes = 30) {
  const centre = await getCentre(pool, centreId);
  const { rows } = await pool.query(
    `SELECT res.id, count(r.id) AS upcoming FROM resources res
     LEFT JOIN reservations r ON r.resource_id = res.id AND r.kind = 'service' AND r.status IN ('confirmed', 'in_use')
       AND r.during && tstzrange(now(), now() + make_interval(mins => $2))
     WHERE res.centre_id = $1 AND res.kind = 'equipment' AND 'ultrasound' = ANY(res.capabilities)
       AND NOT EXISTS (SELECT 1 FROM reservations d WHERE d.resource_id = res.id AND d.kind = 'downtime' AND d.status = 'confirmed' AND d.during @> now())
     GROUP BY res.id ORDER BY upcoming DESC, res.name LIMIT 1`,
    [centre.id, minutes],
  );
  if (!rows[0]) return { skipped: 'Every ultrasound machine is already down' };
  return markResourceDown(centre, rows[0].id, minutes, 'Probe fault — service engineer called', 'simulator');
}

export async function simCancel(centreId) {
  const centre = await getCentre(pool, centreId);
  const { rows } = await pool.query(
    `SELECT v.id FROM visits v
     WHERE v.centre_id = $1 AND v.status = 'booked' AND v.scheduled_at > now() + interval '30 minutes'
     ORDER BY EXISTS (SELECT 1 FROM visit_steps s JOIN services sv ON sv.id = s.service_id
                      WHERE s.visit_id = v.id AND sv.category = 'imaging') DESC, v.scheduled_at
     LIMIT 3`,
    [centre.id],
  );
  if (!rows.length) return { skipped: 'No future bookings to cancel' };
  const pick = rows[Math.floor(Math.random() * rows.length)];
  return { visitId: pick.id, ...(await releaseVisit(centre, pick.id, 'cancelled', 'Patient called to cancel', 'simulator')) };
}

export async function simOverrun(centreId, minutes = 15) {
  const centre = await getCentre(pool, centreId);
  const { rows } = await pool.query(
    `SELECT s.id FROM visit_steps s JOIN visits v ON v.id = s.visit_id JOIN services sv ON sv.id = s.service_id
     WHERE v.centre_id = $1 AND s.status = 'in_service'
     ORDER BY (sv.category = 'imaging') DESC, s.actual_start LIMIT 1`,
    [centre.id],
  );
  if (!rows[0]) return { skipped: 'Nobody is in service right now' };
  return extendStep(centre, rows[0].id, minutes, 'simulator');
}
