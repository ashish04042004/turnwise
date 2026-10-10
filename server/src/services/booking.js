import { randomUUID } from 'node:crypto';
import { conflict, HttpError, isExclusionViolation, lockCentrePlanning, notFound, pool, retryOnConflict, withTx } from '../db.js';
import { enqueueOutbox, notifyPatient, recordEvent } from '../events.js';
import { planSteps } from '../domain/scheduler.js';
import { buildPlannerState, loadSnapshot, newVisitSteps } from './context.js';
import { insertPatient, insertStep, insertVisit, persistPlacement, recordEstimates, releaseStepReservations } from './persist.js';

export const fmtTime = (d, tz) => new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: tz });

export function describePlacements(snap, placements, steps) {
  const resName = new Map(snap.resources.map((r) => [r.id, r.name]));
  return placements
    .map((p) => {
      const svc = snap.services.get(steps.find((s) => s.stepId === p.stepId).serviceId);
      return {
        stepId: p.stepId,
        serviceCode: svc.code,
        serviceName: svc.name,
        start: new Date(p.start).toISOString(),
        end: new Date(p.end).toISOString(),
        resources: p.resourceIds.map((id) => resName.get(id) ?? id),
      };
    })
    .sort((a, b) => a.start.localeCompare(b.start));
}

/**
 * Releases holds whose time is up. Called inline before every capacity
 * decision (so correctness never depends on a worker being alive) and
 * periodically by the worker (so dashboards stay tidy).
 */
export async function expireHolds(db, centreId) {
  const { rows: expired } = await db.query(
    `UPDATE reservations SET status = 'expired', released_at = now()
     WHERE centre_id = $1 AND status = 'held' AND hold_expires_at <= now()
     RETURNING step_id`,
    [centreId],
  );
  if (expired.length === 0) return 0;
  const stepIds = [...new Set(expired.map((r) => r.step_id))];
  await db.query(`UPDATE visit_steps SET status = 'cancelled', version = version + 1 WHERE id = ANY($1) AND status = 'scheduled'`, [stepIds]);
  const { rows: visits } = await db.query(
    `UPDATE visits SET status = 'expired'
     WHERE status = 'held' AND id IN (SELECT visit_id FROM visit_steps WHERE id = ANY($1))
     RETURNING id`,
    [stepIds],
  );
  const visitIds = visits.map((v) => v.id);
  if (visitIds.length === 0) return 0;

  // An expired waitlist offer hands the same opening to the next candidate.
  const { rows: offers } = await db.query(
    `SELECT id, offered_visit_id, capacity_released_at FROM waitlist_entries
     WHERE offered_visit_id = ANY($1) AND status = 'offered' FOR UPDATE`,
    [visitIds],
  );
  await db.query(
    `UPDATE waitlist_entries SET status = 'waiting', last_offer_expired_at = now(), offered_visit_id = NULL, offer_expires_at = NULL
     WHERE id = ANY($1)`,
    [offers.map((o) => o.id)],
  );
  for (const o of offers) {
    const { rows: slots } = await db.query(
      `SELECT r.resource_id, lower(r.during) AS start, upper(r.during) AS "end"
       FROM reservations r JOIN visit_steps s ON s.id = r.step_id WHERE s.visit_id = $1`,
      [o.offered_visit_id],
    );
    if (slots.length === 0) continue;
    await enqueueOutbox(
      db,
      centreId,
      'capacity.released',
      {
        resourceIds: [...new Set(slots.map((s) => s.resource_id))],
        start: new Date(Math.min(...slots.map((s) => s.start.getTime()))).toISOString(),
        end: new Date(Math.max(...slots.map((s) => s.end.getTime()))).toISOString(),
        releasedAt: (o.capacity_released_at ?? new Date()).toISOString(),
        reason: 'offer_expired',
      },
      `capacity:offer-expired:${o.offered_visit_id}`,
    );
  }
  for (const id of visitIds) await recordEvent(db, centreId, 'hold.expired', id, {});
  return visitIds.length;
}

/** Feasible start options for a set of services, without reserving anything. */
export async function searchSlots(centre, serviceIds, from, count = 5) {
  const snap = await loadSnapshot(pool, centre);
  const state = buildPlannerState(snap, new Set());
  const options = [];
  const seen = new Set();
  let t = Math.max(from?.getTime() ?? 0, snap.clock.now);
  let reason = null;
  while (options.length < count) {
    const steps = newVisitSteps(snap, { visitId: 'probe', serviceIds, earliest: t, priority: 0, label: 'probe' });
    const plan = planSteps(steps, state);
    if (plan.unplaced.length > 0) {
      reason = plan.unplaced[0].reason;
      break;
    }
    const start = Math.min(...plan.placements.map((p) => p.start));
    const end = Math.max(...plan.placements.map((p) => p.end));
    if (!seen.has(start)) {
      seen.add(start);
      options.push({ start: new Date(start).toISOString(), end: new Date(end).toISOString(), steps: describePlacements(snap, plan.placements, steps) });
    }
    t = start + 15 * 60_000;
  }
  return { options, exhaustedReason: options.length < count ? reason : null };
}

/** Temporarily reserves every resource a booking needs; the hold must be confirmed before it expires. */
export async function createHold(centre, input, actor) {
  try {
    return await withTx(async (tx) => {
      await lockCentrePlanning(tx, centre.id);
      await expireHolds(tx, centre.id);
      const snap = await loadSnapshot(tx, centre);
      const visitId = randomUUID();
      const priority = input.priority ?? 0;
      const steps = newVisitSteps(snap, { visitId, serviceIds: input.serviceIds, earliest: input.start.getTime(), priority, label: input.patient.name });
      const plan = planSteps(steps, buildPlannerState(snap, new Set()));
      if (plan.unplaced.length > 0) throw conflict(plan.unplaced[0].reason);
      const firstStart = Math.min(...plan.placements.map((p) => p.start));
      if (firstStart !== input.start.getTime()) {
        throw conflict('That slot is no longer available', { nextAvailable: new Date(firstStart).toISOString() });
      }
      const expiresAt = new Date(snap.clock.now + centre.hold_ttl_seconds * 1000);
      const patientId = await insertPatient(tx, centre.id, input.patient);
      const { public_token } = await insertVisit(tx, {
        id: visitId,
        centreId: centre.id,
        patientId,
        kind: 'appointment',
        status: 'held',
        scheduledAt: new Date(firstStart),
        arrivedAt: null,
        priority,
        notes: input.notes,
      });
      for (const s of steps) await insertStep(tx, { id: s.stepId, visitId, serviceId: s.serviceId, status: 'unscheduled' });
      for (const p of plan.placements) await persistPlacement(tx, centre.id, p, 'held', expiresAt);
      await recordEvent(tx, centre.id, 'booking.held', visitId, { patient: input.patient.name, start: new Date(firstStart) }, actor);
      return { visitId, publicToken: public_token, holdExpiresAt: expiresAt.toISOString(), steps: describePlacements(snap, plan.placements, steps) };
    });
  } catch (err) {
    if (isExclusionViolation(err)) throw conflict('That slot was just taken by another booking');
    throw err;
  }
}

export async function confirmHeldVisit(tx, centre, visitId, actor) {
  const { rows } = await tx.query(
    `SELECT v.status, v.scheduled_at, p.name, p.phone FROM visits v JOIN patients p ON p.id = v.patient_id
     WHERE v.id = $1 AND v.centre_id = $2 FOR UPDATE OF v`,
    [visitId, centre.id],
  );
  const v = rows[0];
  if (!v) throw notFound('Booking');
  if (v.status === 'booked') return { alreadyConfirmed: true };
  if (v.status !== 'held') throw new HttpError(410, 'hold_expired', 'This hold has expired or was released');

  const { rows: check } = await tx.query(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE hold_expires_at > now())::int AS live
     FROM reservations r JOIN visit_steps s ON s.id = r.step_id
     WHERE s.visit_id = $1 AND r.status = 'held'`,
    [visitId],
  );
  if (check[0].total === 0 || check[0].live < check[0].total) throw new HttpError(410, 'hold_expired', 'This hold has expired');

  await tx.query(
    `UPDATE reservations SET status = 'confirmed'
     WHERE status = 'held' AND step_id IN (SELECT id FROM visit_steps WHERE visit_id = $1)`,
    [visitId],
  );
  await tx.query(`UPDATE visits SET status = 'booked' WHERE id = $1`, [visitId]);
  await recordEvent(tx, centre.id, 'booking.confirmed', visitId, { patient: v.name }, actor);
  await notifyPatient(tx, centre.id, {
    visitId,
    phone: v.phone,
    name: v.name,
    message: `Your visit at ${centre.name} is confirmed for ${fmtTime(v.scheduled_at, centre.timezone)}.`,
    key: `confirm:${visitId}`,
  });
  return { alreadyConfirmed: false };
}

export async function confirmHold(centre, visitId, actor) {
  return withTx((tx) => confirmHeldVisit(tx, centre, visitId, actor));
}

/**
 * Plans a walk-in at the earliest feasible time and commits it. Two
 * simultaneous walk-ins may compute the same slot; the loser's insert is
 * rejected by the exclusion constraint and it re-plans on fresh state.
 */
export async function createWalkIn(centre, input, actor) {
  return retryOnConflict(() =>
    withTx(async (tx) => {
      await lockCentrePlanning(tx, centre.id);
      await expireHolds(tx, centre.id);
      const snap = await loadSnapshot(tx, centre);
      const visitId = randomUUID();
      const priority = input.priority ?? 0;
      const steps = newVisitSteps(snap, { visitId, serviceIds: input.serviceIds, earliest: snap.clock.now, priority, label: input.patient.name });
      const plan = planSteps(steps, buildPlannerState(snap, new Set()));
      const patientId = await insertPatient(tx, centre.id, input.patient);
      const { public_token } = await insertVisit(tx, {
        id: visitId,
        centreId: centre.id,
        patientId,
        kind: 'walk_in',
        status: 'arrived',
        scheduledAt: null,
        arrivedAt: new Date(snap.clock.now),
        priority,
        notes: input.notes,
      });
      for (const s of steps) await insertStep(tx, { id: s.stepId, visitId, serviceId: s.serviceId, status: 'unscheduled' });
      for (const p of plan.placements) await persistPlacement(tx, centre.id, p, 'confirmed');
      await recordEstimates(tx, plan.placements.map((p) => ({ stepId: p.stepId, predictedStart: p.start })), 'walk_in');
      const unplaced = plan.unplaced.map((u) => ({
        serviceCode: snap.services.get(steps.find((s) => s.stepId === u.stepId).serviceId).code,
        reason: u.reason,
      }));
      await recordEvent(tx, centre.id, 'walkin.created', visitId, { patient: input.patient.name, unplaced }, actor);
      return { visitId, publicToken: public_token, steps: describePlacements(snap, plan.placements, steps), unplaced };
    }),
  );
}

/**
 * Ends a visit early (cancellation or no-show), releasing its future capacity
 * and recording a recovery task so the opening can be offered to the waitlist.
 */
export async function releaseVisit(centre, visitId, outcome, reason, actor) {
  return withTx(async (tx) => {
    const { rows } = await tx.query(
      `SELECT v.status, p.name, p.phone FROM visits v JOIN patients p ON p.id = v.patient_id
       WHERE v.id = $1 AND v.centre_id = $2 FOR UPDATE OF v`,
      [visitId, centre.id],
    );
    const v = rows[0];
    if (!v) throw notFound('Visit');
    const allowed = outcome === 'no_show' ? ['booked'] : ['held', 'booked', 'arrived'];
    if (!allowed.includes(v.status)) throw conflict(`Cannot mark a ${v.status} visit as ${outcome.replace('_', '-')}`);
    const { rows: busy } = await tx.query(`SELECT 1 FROM visit_steps WHERE visit_id = $1 AND status = 'in_service'`, [visitId]);
    if (busy.length > 0) throw conflict('Patient is currently in service; complete that step first');

    const { rows: steps } = await tx.query(
      `SELECT id FROM visit_steps WHERE visit_id = $1 AND status NOT IN ('completed', 'cancelled') FOR UPDATE`,
      [visitId],
    );
    const stepIds = steps.map((s) => s.id);
    const released = await releaseStepReservations(tx, stepIds);
    await tx.query(`UPDATE visit_steps SET status = 'cancelled', version = version + 1 WHERE id = ANY($1)`, [stepIds]);
    await tx.query(`UPDATE visits SET status = $2, cancelled_at = now() WHERE id = $1`, [visitId, outcome]);
    await tx.query(
      `UPDATE waitlist_entries SET status = 'waiting', offered_visit_id = NULL, offer_expires_at = NULL
       WHERE offered_visit_id = $1 AND status = 'offered'`,
      [visitId],
    );

    const now = (await tx.query('SELECT now() AS now')).rows[0].now;
    const byStep = new Map();
    for (const r of released) if (r.end > now) byStep.set(r.step_id, [...(byStep.get(r.step_id) ?? []), r]);
    if (v.status !== 'held') {
      for (const [stepId, rs] of byStep) {
        await enqueueOutbox(
          tx,
          centre.id,
          'capacity.released',
          {
            stepId,
            resourceIds: rs.map((r) => r.resource_id),
            start: new Date(Math.max(rs[0].start.getTime(), now.getTime())).toISOString(),
            end: rs[0].end.toISOString(),
            releasedAt: now.toISOString(),
            reason: outcome,
          },
          `capacity:${outcome}:${stepId}`,
        );
      }
    }
    await recordEvent(
      tx,
      centre.id,
      outcome === 'no_show' ? 'visit.no_show' : 'visit.cancelled',
      visitId,
      { patient: v.name, reason, releasedSlots: byStep.size },
      actor,
    );
    if (outcome === 'cancelled' && v.status !== 'held') {
      await notifyPatient(tx, centre.id, {
        visitId,
        phone: v.phone,
        name: v.name,
        message: `Your visit at ${centre.name} has been cancelled.`,
        key: `cancel:${visitId}`,
      });
    }
    return { releasedSlots: byStep.size };
  });
}
