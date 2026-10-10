import { cached, invalidate, keys } from '../cache.js';
import { config } from '../config.js';
import { notFound, pool } from '../db.js';
import { suggestNextUp } from '../domain/dispatch.js';
import { waitRange } from '../domain/projection.js';
import { getCentre, granularityMs, loadSnapshot, STEP_SELECT } from './context.js';
import { estimateErrorP80, loadDurationStats, projectSnapshot } from './projections.js';

const iso = (d) => (d == null ? null : new Date(d).toISOString());

const VISIT_ORDER = { in_progress: 0, arrived: 1, held: 2, booked: 3, completed: 4, no_show: 5, cancelled: 6 };

async function loadDay(centre) {
  const snap = await loadSnapshot(pool, centre);
  const { opensAt, closesAt, now } = snap.clock;
  const from = new Date(Math.min(opensAt, now));
  const to = new Date(Math.max(closesAt, now));

  const [stats, p80, reservations, visits, lastEvent, proposal, waitlist] = await Promise.all([
    loadDurationStats(pool, centre.id),
    estimateErrorP80(pool, centre.id),
    pool.query(
      `SELECT r.id, r.resource_id, r.step_id, r.kind, r.status, lower(r.during) AS start, upper(r.during) AS "end", r.reason, r.hold_expires_at
       FROM reservations r
       WHERE r.centre_id = $1 AND r.status IN ('held', 'confirmed', 'in_use', 'completed') AND r.during && tstzrange($2, $3)
         AND (r.status <> 'held' OR r.hold_expires_at > now())`,
      [centre.id, from, to],
    ),
    pool.query(
      `SELECT v.*, p.name AS patient, p.phone FROM visits v JOIN patients p ON p.id = v.patient_id
       WHERE v.centre_id = $1 AND v.status <> 'expired'
         AND (COALESCE(v.scheduled_at, v.created_at) BETWEEN $2 AND $3 OR v.status IN ('arrived', 'in_progress'))`,
      [centre.id, from, to],
    ),
    pool.query(`SELECT COALESCE(max(id), 0) AS id FROM events WHERE centre_id = $1`, [centre.id]),
    pool.query(`SELECT * FROM replan_proposals WHERE centre_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`, [centre.id]),
    pool.query(
      `SELECT w.id, w.status, w.earliest, w.latest, w.offer_expires_at, w.offers_made, w.created_at, p.name AS patient,
              (SELECT array_agg(code) FROM services WHERE id = ANY(w.service_ids)) AS services
       FROM waitlist_entries w JOIN patients p ON p.id = w.patient_id
       WHERE w.centre_id = $1 AND w.status IN ('waiting', 'offered') ORDER BY w.created_at`,
      [centre.id],
    ),
  ]);

  const visitIds = visits.rows.map((v) => v.id);
  const [steps, stepRes] = await Promise.all([
    pool.query(`${STEP_SELECT} WHERE s.visit_id = ANY($1)`, [visitIds]),
    pool.query(
      `SELECT r.step_id, array_agg(res.name ORDER BY res.sort_order) AS names
       FROM reservations r JOIN resources res ON res.id = r.resource_id
       WHERE r.step_id = ANY(SELECT id FROM visit_steps WHERE visit_id = ANY($1))
         AND r.status IN ('held', 'confirmed', 'in_use', 'completed')
       GROUP BY r.step_id`,
      [visitIds],
    ),
  ]);

  return {
    snap,
    projected: projectSnapshot(snap, stats),
    p80,
    reservations: reservations.rows,
    visits: visits.rows,
    steps: steps.rows,
    stepResourceNames: new Map(stepRes.rows.map((r) => [r.step_id, r.names])),
    lastEventId: lastEvent.rows[0].id,
    proposal: proposal.rows[0] ?? null,
    waitlist: waitlist.rows,
  };
}

function shapeVisit(day, v) {
  const { snap, projected, p80 } = day;
  const now = snap.clock.now;
  const steps = day.steps
    .filter((s) => s.visit_id === v.id)
    .map((s) => {
      const svc = snap.services.get(s.service_id);
      const p = projected.get(s.id);
      return {
        id: s.id,
        serviceCode: svc.code,
        serviceName: svc.name,
        category: svc.category,
        status: s.status,
        plannedStart: iso(s.planned_start),
        plannedEnd: iso(s.planned_end),
        originalStart: iso(s.original_start),
        projectedStart: p ? iso(p.start) : null,
        projectedEnd: p ? iso(p.end) : null,
        delayMin: p?.delayMin ?? 0,
        actualStart: iso(s.actual_start),
        actualEnd: iso(s.actual_end),
        resources: day.stepResourceNames.get(s.id) ?? [],
      };
    })
    .sort((a, b) => (a.projectedStart ?? a.plannedStart ?? a.actualStart ?? '~').localeCompare(b.projectedStart ?? b.plannedStart ?? b.actualStart ?? '~'));

  const open = steps.filter((s) => !['completed', 'cancelled'].includes(s.status));
  const next = open.find((s) => s.status === 'in_service') ?? open.find((s) => s.status === 'scheduled') ?? open[0] ?? null;
  const waitMin = next?.projectedStart && next.status === 'scheduled' ? Math.max(0, Math.round((Date.parse(next.projectedStart) - now) / 60_000)) : null;

  const { late_arrival_flag_min: lateAfterMin, running_late_flag_min: runningLateMin } = snap.centre.settings;
  const flags = [];
  if (open.some((s) => s.status === 'displaced' || s.status === 'unscheduled')) flags.push('needs_replan');
  if (v.status === 'booked' && v.scheduled_at && v.scheduled_at.getTime() < now - lateAfterMin * 60_000) flags.push('late_arrival');
  if (open.some((s) => s.delayMin >= runningLateMin)) flags.push('running_late');
  if (open.some((s) => s.status === 'in_service' && s.plannedEnd && Date.parse(s.plannedEnd) < now)) flags.push('overrun');

  return {
    id: v.id,
    patient: v.patient,
    phone: v.phone,
    kind: v.kind,
    status: v.status,
    source: v.source,
    priority: v.priority,
    notes: v.notes,
    scheduledAt: iso(v.scheduled_at),
    arrivedAt: iso(v.arrived_at),
    completedAt: iso(v.completed_at),
    publicToken: v.public_token,
    steps,
    nextStepId: next?.id ?? null,
    waitMin,
    waitRange: waitMin == null ? null : waitRange(waitMin, p80),
    flags,
  };
}

/** Steps that could start now: patient present and free, earlier tests done, required gap elapsed. */
export async function getNextUp(centre) {
  return nextUp(await loadSnapshot(pool, centre));
}

function nextUp(snap) {
  const now = snap.clock.now;
  const g = granularityMs(snap.centre);
  const t = (d) => d?.getTime();
  const inService = new Set(snap.steps.filter((s) => s.status === 'in_service').map((s) => s.visit_id));

  const ready = (s) =>
    (snap.prereqs.get(s.service_id) ?? []).every((p) => {
      const dep = snap.steps.find((x) => x.visit_id === s.visit_id && x.service_id === p.requires_service_id);
      if (!dep) return true;
      return dep.status === 'completed' && t(dep.actual_end) + p.min_gap_min * 60_000 <= now;
    });

  const candidates = snap.steps
    .filter((s) => s.status === 'scheduled' && ['arrived', 'in_progress'].includes(s.visit_status) && !inService.has(s.visit_id) && ready(s))
    .map((s) => {
      const svc = snap.services.get(s.service_id);
      return {
        stepId: s.id,
        visitId: s.visit_id,
        patient: s.patient_name,
        service: svc.code,
        requirements: svc.requirements,
        durationMs: t(s.planned_end) - t(s.planned_start),
        reservedResourceIds: snap.stepResources.get(s.id) ?? [],
        dueAt: t(s.visit_kind === 'appointment' ? s.scheduled_at ?? s.arrived_at : s.arrived_at ?? s.scheduled_at),
        plannedStart: t(s.planned_start),
        kind: s.visit_kind,
        ownBusy: snap.steps
          .filter((o) => o.visit_id === s.visit_id && o.id !== s.id && o.status === 'scheduled' && o.planned_start)
          .map((o) => ({ start: t(o.planned_start), end: t(o.planned_end), stepId: o.id })),
      };
    })
    .filter((c) => c.durationMs > 0 && c.reservedResourceIds.length > 0);

  const busy = new Map();
  for (const r of snap.reservations) {
    const end = r.status === 'in_use' ? Math.max(t(r.end), now + g) : t(r.end);
    const hard = r.kind === 'downtime' || r.status !== 'confirmed';
    busy.set(r.resource_id, [...(busy.get(r.resource_id) ?? []), { start: t(r.start), end, stepId: r.step_id, hard }]);
  }

  const names = new Map(snap.resources.map((r) => [r.id, r.name]));
  return suggestNextUp({ now, resources: snap.resources, busy, candidates }).map((s) => ({
    ...s,
    dueAt: new Date(s.dueAt).toISOString(),
    plannedStart: s.plannedStart == null ? null : new Date(s.plannedStart).toISOString(),
    resources: s.resourceIds.map((id) => names.get(id)),
  }));
}

/**
 * The live floor. Every event invalidates it; the short TTL mostly coalesces
 * many screens refreshing at once. A client that has seen event N passes
 * `minEventId: N`, and a cached board older than that is rebuilt, so a
 * refresh triggered by an event can never be answered from before it.
 */
export async function getBoard(centreId, { minEventId = 0 } = {}) {
  const load = () => cached(keys.board(centreId), config.cache.boardSeconds, () => buildBoard(centreId));
  const board = await load();
  if (board.lastEventId >= minEventId) return board;
  await invalidate(keys.board(centreId));
  return load();
}

async function buildBoard(centreId) {
  const centre = await getCentre(centreId);
  const day = await loadDay(centre);
  const { snap, projected } = day;
  const now = snap.clock.now;

  const visits = day.visits
    .map((v) => shapeVisit(day, v))
    .sort((a, b) => {
      const o = VISIT_ORDER[a.status] - VISIT_ORDER[b.status];
      if (o) return o;
      const ka = a.steps.find((s) => s.id === a.nextStepId)?.projectedStart ?? a.scheduledAt ?? a.arrivedAt ?? '';
      const kb = b.steps.find((s) => s.id === b.nextStepId)?.projectedStart ?? b.scheduledAt ?? b.arrivedAt ?? '';
      return ka.localeCompare(kb);
    });

  const stepIndex = new Map(day.steps.map((s) => [s.id, s]));
  const timeline = day.reservations.map((r) => {
    const s = r.step_id ? stepIndex.get(r.step_id) : null;
    const p = r.step_id ? projected.get(r.step_id) : null;
    return {
      id: r.id,
      resourceId: r.resource_id,
      kind: r.kind,
      status: r.status,
      start: iso(r.start),
      end: iso(r.end),
      reason: r.reason,
      stepId: r.step_id,
      visitId: s?.visit_id ?? null,
      patient: s?.patient_name ?? null,
      service: s ? snap.services.get(s.service_id).code : null,
      projectedStart: p ? iso(p.start) : null,
      projectedEnd: p ? iso(p.end) : null,
    };
  });

  const resources = snap.resources.map((r) => {
    const down = day.reservations.find(
      (x) => x.resource_id === r.id && x.kind === 'downtime' && x.status === 'confirmed' && x.start.getTime() <= now && x.end.getTime() > now,
    );
    const using = timeline.find((x) => x.resourceId === r.id && x.status === 'in_use');
    const state = !r.active ? 'inactive' : down ? 'down' : using ? 'busy' : 'idle';
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      capabilities: r.capabilities,
      active: r.active,
      state,
      downUntil: down ? iso(down.end) : null,
      downReason: down?.reason ?? null,
      current: using ? { patient: using.patient, service: using.service, stepId: using.stepId, since: using.start, until: using.end } : null,
    };
  });

  const displacedCount = day.steps.filter((s) => s.status === 'displaced').length;
  const alerts = [];
  for (const r of resources.filter((x) => x.state === 'down')) alerts.push({ level: 'critical', text: `${r.name} unavailable until ${r.downUntil}`, resourceId: r.id });
  if (displacedCount) alerts.push({ level: 'warning', text: `${displacedCount} service(s) need a new time` });
  const overruns = visits.filter((v) => v.flags.includes('overrun'));
  if (overruns.length) alerts.push({ level: 'warning', text: `${overruns.length} service(s) running past their slot` });
  const late = visits.filter((v) => v.flags.includes('late_arrival'));
  if (late.length) {
    alerts.push({ level: 'info', text: `${late.length} booked patient(s) more than ${centre.settings.late_arrival_flag_min} min late — consider no-show` });
  }

  const categoryOrder = new Map(centre.categories.map((c, i) => [c.code, i]));
  return {
    centre: { id: centre.id, name: centre.name, city: centre.city, timezone: centre.timezone, locale: centre.locale },
    now: iso(now),
    window: { opensAt: iso(snap.clock.opensAt), closesAt: iso(snap.clock.closesAt) },
    lastEventId: day.lastEventId,
    services: [...snap.services.values()].sort(
      (a, b) => (categoryOrder.get(a.category) ?? 99) - (categoryOrder.get(b.category) ?? 99) || a.code.localeCompare(b.code),
    ),
    resources,
    timeline,
    visits,
    nextUp: nextUp(snap),
    proposal: day.proposal && {
      id: day.proposal.id,
      trigger: day.proposal.trigger,
      createdAt: iso(day.proposal.created_at),
      options: day.proposal.options,
    },
    waitlist: day.waitlist.map((w) => ({ ...w, earliest: iso(w.earliest), latest: iso(w.latest), offer_expires_at: iso(w.offer_expires_at) })),
    alerts,
    summary: {
      waiting: visits.filter((v) => v.status === 'arrived').length,
      inService: visits.filter((v) => v.status === 'in_progress').length,
      upcoming: visits.filter((v) => v.status === 'booked').length,
      completed: visits.filter((v) => v.status === 'completed').length,
      needsReplan: displacedCount,
      estimateBandMin: day.p80 == null ? null : Math.round(day.p80),
    },
  };
}

/** What a patient sees: no other patients' details, just their own progress and a wait range. */
export async function getPatientView(token) {
  const { rows } = await pool.query(`SELECT centre_id, id FROM visits WHERE public_token = $1`, [token]);
  if (!rows[0]) throw notFound('Visit');
  const centre = await getCentre(rows[0].centre_id);
  const day = await loadDay(centre);
  const raw = day.visits.find((v) => v.id === rows[0].id) ?? (await pool.query(
    `SELECT v.*, p.name AS patient, p.phone FROM visits v JOIN patients p ON p.id = v.patient_id WHERE v.id = $1`,
    [rows[0].id],
  )).rows[0];
  if (!day.steps.some((s) => s.visit_id === raw.id)) {
    day.steps.push(...(await pool.query(`${STEP_SELECT} WHERE s.visit_id = $1`, [raw.id])).rows);
  }
  const v = shapeVisit(day, raw);
  const { rows: offer } = await pool.query(
    `SELECT offer_expires_at FROM waitlist_entries WHERE offered_visit_id = $1 AND status = 'offered'`,
    [raw.id],
  );
  return {
    centre: { name: centre.name, city: centre.city, timezone: centre.timezone },
    now: day.snap.clock.now,
    firstName: v.patient.split(' ')[0],
    status: v.status,
    scheduledAt: v.scheduledAt,
    waitMin: v.waitMin,
    waitRange: v.waitRange,
    offer: offer[0] ? { expiresAt: iso(offer[0].offer_expires_at) } : null,
    steps: v.steps.map((s) => ({
      service: s.serviceName,
      status: s.status,
      plannedStart: s.plannedStart,
      projectedStart: s.projectedStart,
      delayMin: s.delayMin,
      actualStart: s.actualStart,
      actualEnd: s.actualEnd,
    })),
  };
}
