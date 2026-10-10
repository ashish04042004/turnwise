import { pool } from '../db.js';
import { getNextUp } from './board.js';
import { getCentre } from './context.js';
import { createWalkIn, releaseVisit } from './booking.js';
import { checkIn, completeStep, extendStep, startStep } from './operations.js';
import { markResourceDown } from './replan.js';
import { drawServices, syntheticPeople, unit } from './synthetic.js';

/**
 * One step of the floor autopilot: patients arrive (some late, some never),
 * staff call patients as "Next up" suggests, and services finish after a
 * realistic, sometimes overrunning, duration.
 */
export async function simTick(centreId) {
  const centre = await getCentre(centreId);
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
  const { sim_no_show_rate: noShowRate, sim_early_rate: earlyRate } = centre.settings;
  for (const v of due) {
    if (unit(`noshow${v.id}`) < noShowRate) continue;
    const offsetMin = unit(`arrive${v.id}`) < earlyRate ? -10 * unit(`early${v.id}`) : 15 * unit(`late${v.id}`);
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

  // Staff follow "Next up": anything that moves nobody, or whose booked time has come.
  for (const s of await getNextUp(centre)) {
    if (s.bumps > 0 && !s.bookedTimeReached) continue;
    await attempt(`${s.patient} started ${s.service}`, () => startStep(centre, s.stepId, {}, 'simulator'));
  }

  return { actions };
}

export async function simWalkInRush(centreId, count = 3) {
  const centre = await getCentre(centreId);
  const people = await syntheticPeople(centre);
  const { rows: services } = await pool.query(`SELECT id, code FROM services WHERE centre_id = $1`, [centre.id]);
  const byCode = new Map(services.map((s) => [s.code, s.id]));
  // Fired concurrently on purpose: the reservation engine must arbitrate.
  const results = await Promise.allSettled(
    Array.from({ length: count }, (_, i) => {
      const seed = `${Date.now()}-${i}`;
      const codes = drawServices(centre, 'walk_in', unit(`mix${seed}`), byCode);
      return createWalkIn(centre, { patient: { name: people.name(seed), phone: people.phone(seed) }, serviceIds: codes.map((c) => byCode.get(c)) }, 'simulator');
    }),
  );
  return {
    created: results.filter((r) => r.status === 'fulfilled').length,
    failed: results.filter((r) => r.status === 'rejected').map((r) => r.reason.message),
  };
}

export async function simBreakdown(centreId, minutes = 30) {
  const centre = await getCentre(centreId);
  const { rows } = await pool.query(
    `SELECT res.id, count(r.id) AS upcoming FROM resources res
     LEFT JOIN reservations r ON r.resource_id = res.id AND r.kind = 'service' AND r.status IN ('confirmed', 'in_use')
       AND r.during && tstzrange(now(), now() + make_interval(mins => $2))
     WHERE res.centre_id = $1 AND res.kind = 'equipment' AND $3 = ANY(res.capabilities)
       AND NOT EXISTS (SELECT 1 FROM reservations d WHERE d.resource_id = res.id AND d.kind = 'downtime' AND d.status = 'confirmed' AND d.during @> now())
     GROUP BY res.id ORDER BY upcoming DESC, res.name LIMIT 1`,
    [centre.id, minutes, centre.settings.sim_breakdown_capability],
  );
  if (!rows[0]) return { skipped: `No ${centre.settings.sim_breakdown_capability} equipment is available to break down` };
  return markResourceDown(centre, rows[0].id, minutes, centre.settings.sim_breakdown_reason, 'simulator');
}

export async function simCancel(centreId) {
  const centre = await getCentre(centreId);
  const { rows } = await pool.query(
    `SELECT v.id FROM visits v
     WHERE v.centre_id = $1 AND v.status = 'booked' AND v.scheduled_at > now() + interval '30 minutes'
     ORDER BY EXISTS (SELECT 1 FROM visit_steps s JOIN services sv ON sv.id = s.service_id
                      WHERE s.visit_id = v.id AND sv.category = $2) DESC, v.scheduled_at
     LIMIT 3`,
    [centre.id, centre.settings.sim_focus_category],
  );
  if (!rows.length) return { skipped: 'No future bookings to cancel' };
  const pick = rows[Math.floor(Math.random() * rows.length)];
  return { visitId: pick.id, ...(await releaseVisit(centre, pick.id, 'cancelled', 'Patient called to cancel', 'simulator')) };
}

export async function simOverrun(centreId, minutes = 15) {
  const centre = await getCentre(centreId);
  const { rows } = await pool.query(
    `SELECT s.id FROM visit_steps s JOIN visits v ON v.id = s.visit_id JOIN services sv ON sv.id = s.service_id
     WHERE v.centre_id = $1 AND s.status = 'in_service'
     ORDER BY (sv.category = $2) DESC, s.actual_start LIMIT 1`,
    [centre.id, centre.settings.sim_focus_category],
  );
  if (!rows[0]) return { skipped: 'Nobody is in service right now' };
  return extendStep(centre, rows[0].id, minutes, 'simulator');
}
