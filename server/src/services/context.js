import { randomUUID } from 'node:crypto';
import { badRequest, notFound, pool } from '../db.js';

export { getCentre } from './reference.js';

/** Planner time granularity for a centre, in milliseconds. */
export const granularityMs = (centre) => centre.settings.slot_granularity_min * 60_000;

/** The database clock is the only clock, so every API process and worker agrees on "now". */
export async function getClock(db, centre) {
  const { rows } = await db.query(
    `SELECT now() AS now,
            (date_trunc('day', now() AT TIME ZONE $1) + $2::time) AT TIME ZONE $1 AS opens,
            (date_trunc('day', now() AT TIME ZONE $1) + $3::time) AT TIME ZONE $1 AS closes`,
    [centre.timezone, centre.opens_at, centre.closes_at],
  );
  return { now: rows[0].now.getTime(), opensAt: rows[0].opens.getTime(), closesAt: rows[0].closes.getTime() };
}

export const STEP_SELECT = `
  SELECT s.id, s.visit_id, s.service_id, s.status,
         lower(s.planned) AS planned_start, upper(s.planned) AS planned_end,
         s.original_start, s.actual_start, s.actual_end, s.version,
         v.status AS visit_status, v.kind AS visit_kind, v.scheduled_at, v.arrived_at, v.priority,
         p.name AS patient_name, p.phone AS patient_phone, v.public_token
  FROM visit_steps s
  JOIN visits v ON v.id = s.visit_id
  JOIN patients p ON p.id = v.patient_id`;

const groupBy = (rows, key, value = (r) => r) => {
  const m = new Map();
  for (const r of rows) m.set(r[key], [...(m.get(r[key]) ?? []), value(r)]);
  return m;
};

/** Pool queries run in parallel; a transaction's single connection must run them one at a time. */
async function runAll(db, thunks) {
  if (db === pool) return Promise.all(thunks.map((t) => t()));
  const out = [];
  for (const t of thunks) out.push(await t());
  return out;
}

/** Everything the planner needs. Inside a transaction, all reads share its view of the data. */
export async function loadSnapshot(db, centre) {
  const clock = await getClock(db, centre);
  const [resources, services, prereqs, reservations, steps, previous] = await runAll(db, [
    () =>
      db.query('SELECT id, name, kind, capabilities, active, sort_order FROM resources WHERE centre_id = $1 ORDER BY sort_order, name', [
        centre.id,
      ]),
    () => db.query('SELECT id, code, name, category, duration_min, requirements, active, sort_order FROM services WHERE centre_id = $1', [centre.id]),
    () => db.query('SELECT sp.* FROM service_prerequisites sp JOIN services s ON s.id = sp.service_id WHERE s.centre_id = $1', [centre.id]),
    () => db.query(
      `SELECT id, resource_id, step_id, kind, status, lower(during) AS start, upper(during) AS "end", hold_expires_at, reason
       FROM reservations
       WHERE centre_id = $1 AND status IN ('held', 'confirmed', 'in_use')
         AND upper(during) > now() - interval '12 hours'
         AND (status <> 'held' OR hold_expires_at > now())`,
      [centre.id],
    ),
    () => db.query(
      `${STEP_SELECT}
       WHERE v.centre_id = $1
         AND (s.status IN ('scheduled', 'displaced', 'unscheduled', 'in_service')
              OR (s.status = 'completed' AND s.actual_end > now() - interval '1 day'))`,
      [centre.id],
    ),
    () => db.query(
      `SELECT DISTINCT r.step_id, r.resource_id
       FROM reservations r JOIN visit_steps s ON s.id = r.step_id
       WHERE r.centre_id = $1 AND s.status = 'displaced' AND r.status = 'released'`,
      [centre.id],
    ),
  ]);

  return {
    centre,
    clock,
    resources: resources.rows,
    services: new Map(services.rows.map((s) => [s.id, s])),
    prereqs: groupBy(prereqs.rows, 'service_id'),
    reservations: reservations.rows,
    steps: steps.rows,
    stepResources: groupBy(
      reservations.rows.filter((r) => r.kind === 'service'),
      'step_id',
      (r) => r.resource_id,
    ),
    /** Resources a displaced step held before it lost its reservation. */
    previousResources: groupBy(previous.rows, 'step_id', (r) => r.resource_id),
  };
}

/**
 * Builds the planner's view of fixed capacity, treating `moving` steps as
 * free to re-place. In-use resources count as busy until shortly after now,
 * since an overrunning service has not released them yet.
 */
export function buildPlannerState(snap, moving) {
  const g = granularityMs(snap.centre);
  const resourceBusy = new Map();
  const visitBusy = new Map();
  const fixedStepEnds = new Map();
  const push = (m, k, i) => m.set(k, [...(m.get(k) ?? []), i]);

  for (const r of snap.reservations) {
    if (r.step_id && moving.has(r.step_id)) continue;
    let end = r.end.getTime();
    if (r.status === 'in_use') end = Math.max(end, snap.clock.now + g);
    push(resourceBusy, r.resource_id, { start: r.start.getTime(), end });
  }

  for (const s of snap.steps) {
    if (moving.has(s.id)) continue;
    if ((s.status === 'scheduled' || s.status === 'in_service') && s.planned_start && s.planned_end) {
      let end = s.planned_end.getTime();
      if (s.status === 'in_service') end = Math.max(end, snap.clock.now + g);
      push(visitBusy, s.visit_id, { start: s.planned_start.getTime(), end });
      fixedStepEnds.set(s.id, end);
    } else if (s.status === 'completed' && s.actual_end) {
      fixedStepEnds.set(s.id, s.actual_end.getTime());
    }
  }

  return { horizonEnd: snap.clock.closesAt, granularityMs: g, resources: snap.resources, resourceBusy, visitBusy, fixedStepEnds };
}

/** Converts a persisted step into a planner step. */
export function toPlannerStep(snap, step, { earliest, preferResources = false }) {
  const service = snap.services.get(step.service_id);
  if (!service) throw notFound(`Service ${step.service_id}`);
  const siblings = snap.steps.filter((s) => s.visit_id === step.visit_id && s.id !== step.id);
  const prereqs = (snap.prereqs.get(step.service_id) ?? []).flatMap((p) => {
    const dep = siblings.find((s) => s.service_id === p.requires_service_id);
    return dep ? [{ stepId: dep.id, minGapMin: p.min_gap_min }] : [];
  });
  return {
    stepId: step.id,
    visitId: step.visit_id,
    label: `${step.patient_name} · ${service.code}`,
    durationMin: service.duration_min,
    requirements: service.requirements,
    earliest,
    priority: step.priority,
    orderKey: (step.original_start ?? step.planned_start ?? step.scheduled_at ?? new Date(snap.clock.now)).getTime(),
    preferredResourceIds: preferResources ? snap.stepResources.get(step.id) ?? snap.previousResources.get(step.id) : undefined,
    prereqs,
  };
}

/** Planner steps for a visit that does not exist yet (walk-in, booking, waitlist offer). */
export function newVisitSteps(snap, { visitId, serviceIds, earliest, priority, label }) {
  if (serviceIds.length === 0) throw badRequest('At least one service is required');
  if (new Set(serviceIds).size !== serviceIds.length) throw badRequest('Duplicate services in request');
  const ids = new Map(serviceIds.map((sid) => [sid, randomUUID()]));
  return serviceIds.map((sid) => {
    const service = snap.services.get(sid);
    if (!service) throw badRequest(`Unknown service ${sid}`);
    if (!service.active) throw badRequest(`${service.name} is no longer offered`);
    return {
      serviceId: sid,
      stepId: ids.get(sid),
      visitId,
      label: `${label} · ${service.code}`,
      durationMin: service.duration_min,
      requirements: service.requirements,
      earliest,
      priority,
      orderKey: earliest,
      prereqs: (snap.prereqs.get(sid) ?? [])
        .filter((p) => ids.has(p.requires_service_id))
        .map((p) => ({ stepId: ids.get(p.requires_service_id), minGapMin: p.min_gap_min })),
    };
  });
}
