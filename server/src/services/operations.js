import { config } from '../config.js';
import { conflict, notFound, pool, withTx } from '../db.js';
import { recordEvent } from '../events.js';
import { getCentre, loadSnapshot } from './context.js';
import { fmtTime } from './booking.js';
import { recordEstimates } from './persist.js';
import { loadDurationStats, projectSnapshot } from './projections.js';
import { displaceSteps, generateProposal } from './replan.js';

async function lockStep(tx, centreId, stepId) {
  const { rows } = await tx.query(
    `SELECT s.id, s.status, s.visit_id, s.actual_start, lower(s.planned) AS planned_start, upper(s.planned) AS planned_end,
            v.status AS visit_status, sv.code AS service, p.name AS patient, now() AS now
     FROM visit_steps s JOIN visits v ON v.id = s.visit_id JOIN services sv ON sv.id = s.service_id
     JOIN patients p ON p.id = v.patient_id
     WHERE s.id = $1 AND v.centre_id = $2 FOR UPDATE OF s, v`,
    [stepId, centreId],
  );
  if (!rows[0]) throw notFound('Step');
  return rows[0];
}

/**
 * Moves a step onto [start, end) on its reserved resources. Later bookings it
 * now overlaps are displaced (delay propagation); earlier bookings are
 * protected unless staff explicitly force the override.
 */
async function occupy(tx, centre, step, start, end, { protectBefore = null, force = false, reason, actor }) {
  const { rows: mine } = await tx.query(`SELECT resource_id FROM reservations WHERE step_id = $1 AND status IN ('confirmed', 'in_use')`, [step.id]);
  if (mine.length === 0) throw conflict('This step has no active reservation; re-plan it first');
  const rids = mine.map((r) => r.resource_id);

  const { rows: clashes } = await tx.query(
    `SELECT r.step_id, r.kind, r.status, lower(r.during) AS start, res.name AS resource, p.name AS patient
     FROM reservations r JOIN resources res ON res.id = r.resource_id
     LEFT JOIN visit_steps s ON s.id = r.step_id LEFT JOIN visits v ON v.id = s.visit_id LEFT JOIN patients p ON p.id = v.patient_id
     WHERE r.resource_id = ANY($1) AND r.status IN ('held', 'confirmed', 'in_use')
       AND r.during && tstzrange($2, $3, '[)') AND r.step_id IS DISTINCT FROM $4`,
    [rids, start, end, step.id],
  );
  for (const c of clashes) {
    if (c.kind === 'downtime') throw conflict(`${c.resource} is marked unavailable`);
    if (c.status === 'in_use') throw conflict(`${c.resource} is still busy with ${c.patient}`);
    if (!force && protectBefore && c.start < protectBefore) {
      throw conflict(`${c.resource} is booked for ${c.patient} at ${fmtTime(c.start, centre.timezone)}`, { canForce: true });
    }
  }
  const { rows: own } = await tx.query(
    `SELECT id, status FROM visit_steps
     WHERE visit_id = $1 AND id <> $2 AND status IN ('scheduled', 'in_service') AND planned && tstzrange($3, $4, '[)')`,
    [step.visit_id, step.id, start, end],
  );
  if (own.some((o) => o.status === 'in_service')) throw conflict(`${step.patient} is in another service`);

  const victims = [...new Set([...clashes.map((c) => c.step_id), ...own.map((o) => o.id)])];
  const displaced = await displaceSteps(tx, centre.id, victims, reason, actor);

  await tx.query(
    `UPDATE reservations SET during = tstzrange($2, $3, '[)'), status = 'in_use' WHERE step_id = $1 AND status IN ('confirmed', 'in_use')`,
    [step.id, start, end],
  );
  await tx.query(
    `UPDATE visit_steps SET planned = tstzrange($2, $3, '[)'), status = 'in_service', actual_start = COALESCE(actual_start, $2), version = version + 1
     WHERE id = $1`,
    [step.id, start, end],
  );
  return displaced;
}

async function proposeIfDisplaced(centre, displaced, trigger, actor) {
  if (displaced.length === 0) return null;
  const proposal = await generateProposal(centre, trigger, actor);
  return proposal?.id ?? null;
}

export async function checkIn(centre, visitId, actor) {
  return withTx(async (tx) => {
    const { rows } = await tx.query(
      `SELECT v.status, v.scheduled_at, p.name FROM visits v JOIN patients p ON p.id = v.patient_id
       WHERE v.id = $1 AND v.centre_id = $2 FOR UPDATE OF v`,
      [visitId, centre.id],
    );
    const v = rows[0];
    if (!v) throw notFound('Visit');
    if (v.status !== 'booked') throw conflict(`Cannot check in a ${v.status} visit`);
    await tx.query(`UPDATE visits SET status = 'arrived', arrived_at = now() WHERE id = $1`, [visitId]);

    // Record what we are promising this patient so accuracy can be audited later.
    const snap = await loadSnapshot(tx, centre);
    const projected = projectSnapshot(snap, await loadDurationStats(tx, centre.id));
    const estimates = snap.steps
      .filter((s) => s.visit_id === visitId && projected.has(s.id))
      .map((s) => ({ stepId: s.id, predictedStart: projected.get(s.id).start }));
    await recordEstimates(tx, estimates, 'check_in');

    const lateMin = v.scheduled_at ? Math.round((snap.clock.now - v.scheduled_at.getTime()) / 60_000) : 0;
    await recordEvent(tx, centre.id, 'visit.checked_in', visitId, { patient: v.name, lateMin }, actor);
    return { estimates: estimates.map((e) => ({ ...e, predictedStart: new Date(e.predictedStart).toISOString() })) };
  });
}

export async function startStep(centre, stepId, { force = false } = {}, actor) {
  const result = await withTx(async (tx) => {
    const s = await lockStep(tx, centre.id, stepId);
    if (s.status !== 'scheduled') throw conflict(`Step is ${s.status}`);
    if (!['arrived', 'in_progress'].includes(s.visit_status)) throw conflict(`Check ${s.patient} in before starting`);
    const start = s.now;
    const end = new Date(start.getTime() + (s.planned_end - s.planned_start));
    const displaced = await occupy(tx, centre, s, start, end, {
      protectBefore: s.planned_start,
      force,
      reason: `${s.service} for ${s.patient} started at ${fmtTime(start, centre.timezone)}`,
      actor,
    });
    await tx.query(`UPDATE visits SET status = 'in_progress' WHERE id = $1`, [s.visit_id]);
    const lateMin = Math.round((start - s.planned_start) / 60_000);
    await recordEvent(tx, centre.id, 'step.started', stepId, { patient: s.patient, service: s.service, lateMin, forced: force }, actor);
    return { s, displaced, lateMin };
  });
  const proposalId = await proposeIfDisplaced(
    centre,
    result.displaced,
    `${result.s.service} for ${result.s.patient} started ${result.lateMin > 0 ? `${result.lateMin} min late` : 'out of order'}`,
    actor,
  );
  return { displaced: result.displaced, proposalId };
}

export async function completeStep(centre, stepId, actor) {
  return withTx(async (tx) => {
    const s = await lockStep(tx, centre.id, stepId);
    if (s.status !== 'in_service') throw conflict(`Step is ${s.status}`);
    await tx.query(
      `UPDATE reservations SET status = 'completed', during = tstzrange(lower(during), greatest(now(), lower(during) + interval '1 second'), '[)')
       WHERE step_id = $1 AND status = 'in_use'`,
      [stepId],
    );
    await tx.query(`UPDATE visit_steps SET status = 'completed', actual_end = now(), version = version + 1 WHERE id = $1`, [stepId]);
    const { rows } = await tx.query(
      `SELECT count(*)::int AS remaining FROM visit_steps WHERE visit_id = $1 AND status NOT IN ('completed', 'cancelled')`,
      [s.visit_id],
    );
    const done = rows[0].remaining === 0;
    await tx.query(`UPDATE visits SET status = $2, completed_at = CASE WHEN $3 THEN now() END WHERE id = $1`, [
      s.visit_id,
      done ? 'completed' : 'arrived',
      done,
    ]);
    const durationMin = Math.round((s.now - s.actual_start) / 60_000);
    await recordEvent(tx, centre.id, 'step.completed', stepId, { patient: s.patient, service: s.service, durationMin, visitCompleted: done }, actor);
    return { visitCompleted: done, durationMin };
  });
}

/** Staff (or the overrun sweeper) report that an in-progress service needs more time. */
export async function extendStep(centre, stepId, minutes, actor) {
  const result = await withTx(async (tx) => {
    const s = await lockStep(tx, centre.id, stepId);
    if (s.status !== 'in_service') throw conflict(`Step is ${s.status}`);
    const end = new Date(Math.max(s.planned_end.getTime(), s.now.getTime()) + minutes * 60_000);
    const displaced = await occupy(tx, centre, s, s.actual_start, end, { force: true, reason: `${s.service} for ${s.patient} is overrunning`, actor });
    await recordEvent(tx, centre.id, 'step.extended', stepId, { patient: s.patient, service: s.service, minutes, displaced: displaced.length }, actor);
    return { s, displaced };
  });
  const proposalId = await proposeIfDisplaced(
    centre,
    result.displaced,
    `${result.s.service} for ${result.s.patient} running ${minutes} min over`,
    actor,
  );
  return { displaced: result.displaced, proposalId };
}

/**
 * Extends services that have run well past their reservation, turning a
 * persistent overrun into an explicit re-plan instead of a silent conflict.
 * Short overruns only show up as projected delay.
 */
export async function sweepOverruns(centreId) {
  const centre = await getCentre(pool, centreId);
  const { rows } = await pool.query(
    `SELECT s.id FROM visit_steps s JOIN visits v ON v.id = s.visit_id
     WHERE v.centre_id = $1 AND s.status = 'in_service' AND upper(s.planned) <= now() - make_interval(mins => $2)`,
    [centreId, config.overrunGraceMin],
  );
  let extended = 0;
  for (const r of rows) {
    try {
      await extendStep(centre, r.id, 5, 'overrun-sweeper');
      extended++;
    } catch (err) {
      if (err.status !== 409) throw err;
    }
  }
  return extended;
}
