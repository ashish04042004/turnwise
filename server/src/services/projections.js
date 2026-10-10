import { expectedDuration, projectSchedule } from '../domain/projection.js';

/** Observed service durations over the last 30 days, used to learn realistic estimates. */
export async function loadDurationStats(db, centreId) {
  const { rows } = await db.query(
    `SELECT s.service_id, avg(extract(epoch FROM s.actual_end - s.actual_start)) / 60 AS mean, count(*)::int AS n
     FROM visit_steps s JOIN visits v ON v.id = s.visit_id
     WHERE v.centre_id = $1 AND s.status = 'completed' AND s.actual_end > now() - interval '30 days'
     GROUP BY s.service_id`,
    [centreId],
  );
  return new Map(rows.map((r) => [r.service_id, r]));
}

export function expectedMinFor(snap, stats, serviceId) {
  const svc = snap.services.get(serviceId);
  const st = stats.get(serviceId);
  return expectedDuration(svc.duration_min, st?.mean ?? null, st?.n ?? 0);
}

/** Live estimate of when every committed step will actually start and end. */
export function projectSnapshot(snap, stats) {
  const steps = snap.steps
    .filter((s) => (s.status === 'scheduled' || s.status === 'in_service') && s.planned_start)
    .map((s) => ({
      stepId: s.id,
      visitId: s.visit_id,
      status: s.status,
      plannedStart: s.planned_start.getTime(),
      plannedEnd: s.planned_end.getTime(),
      actualStart: s.actual_start?.getTime() ?? null,
      expectedMin: expectedMinFor(snap, stats, s.service_id),
      resourceIds: snap.stepResources.get(s.id) ?? [],
    }));
  return projectSchedule(steps, snap.clock.now);
}

/** p80 of |actual start - promised start| today; calibrates wait ranges. */
export async function estimateErrorP80(db, centreId) {
  const { rows } = await db.query(
    `WITH first_promise AS (
       SELECT DISTINCT ON (e.step_id) e.step_id, e.predicted_start
       FROM estimate_snapshots e ORDER BY e.step_id, e.made_at
     )
     SELECT percentile_cont(0.8) WITHIN GROUP (ORDER BY abs(extract(epoch FROM s.actual_start - fp.predicted_start)) / 60) AS p80
     FROM first_promise fp
     JOIN visit_steps s ON s.id = fp.step_id
     JOIN visits v ON v.id = s.visit_id
     WHERE v.centre_id = $1 AND s.actual_start IS NOT NULL AND s.actual_start > now() - interval '1 day'`,
    [centreId],
  );
  return rows[0]?.p80 ?? null;
}
