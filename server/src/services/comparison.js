import { cached, keys } from '../cache.js';
import { config } from '../config.js';
import { pool } from '../db.js';
import { compareStrategies } from '../domain/compare.js';
import { getCentre, getClock, granularityMs } from './context.js';

/** Today's real demand (who came, when, for which tests), stripped of how it was actually scheduled. */
export async function loadScenario(db, centre) {
  const clock = await getClock(db, centre);
  const [resources, services, prereqs, visits] = await Promise.all([
    db.query(`SELECT id, name, capabilities, true AS active FROM resources WHERE centre_id = $1 AND active ORDER BY name`, [centre.id]),
    // A token system sends patients through departments in the centre's configured category order.
    db.query(
      `SELECT s.code, s.duration_min, s.requirements FROM services s
       JOIN service_categories c ON c.centre_id = s.centre_id AND c.code = s.category
       WHERE s.centre_id = $1 ORDER BY c.sort_order, c.code, s.code`,
      [centre.id],
    ),
    db.query(
      `SELECT s.code, r.code AS requires, p.min_gap_min FROM service_prerequisites p
       JOIN services s ON s.id = p.service_id JOIN services r ON r.id = p.requires_service_id WHERE s.centre_id = $1`,
      [centre.id],
    ),
    db.query(
      `SELECT v.id, v.kind, v.scheduled_at, COALESCE(v.arrived_at, v.scheduled_at) AS arrival, array_agg(sv.code ORDER BY sv.code) AS codes
       FROM visits v JOIN visit_steps st ON st.visit_id = v.id AND st.status <> 'cancelled' JOIN services sv ON sv.id = st.service_id
       WHERE v.centre_id = $1 AND v.status IN ('booked', 'arrived', 'in_progress', 'completed')
         AND COALESCE(v.arrived_at, v.scheduled_at) BETWEEN $2 AND $3
       GROUP BY v.id`,
      [centre.id, new Date(clock.opensAt), new Date(clock.closesAt)],
    ),
  ]);

  const prereqMap = new Map();
  for (const p of prereqs.rows) prereqMap.set(p.code, [...(prereqMap.get(p.code) ?? []), { requires: p.requires, minGapMin: p.min_gap_min }]);
  return {
    open: clock.opensAt,
    close: clock.closesAt,
    granularityMs: granularityMs(centre),
    resources: resources.rows,
    lateBinding: true,
    dispatch: 'due',
    services: new Map(services.rows.map((s, order) => [s.code, { durationMin: s.duration_min, requirements: s.requirements, order }])),
    prereqs: prereqMap,
    visits: visits.rows.map((v) => ({
      id: v.id,
      kind: v.kind,
      arrival: v.arrival.getTime(),
      scheduledAt: (v.scheduled_at ?? v.arrival).getTime(),
      codes: v.codes,
    })),
  };
}

/** Turnwise vs a department-queue (token) system on today's demand. CPU-bound, so cached and shared across replicas. */
export async function getBaselineComparison(centreId) {
  const centre = await getCentre(centreId);
  return cached(keys.comparison(centre.id), config.cache.comparisonSeconds, async () => {
    const scenario = await loadScenario(pool, centre);
    if (scenario.visits.length === 0) return null;
    const t0 = performance.now();
    const result = compareStrategies(scenario, { replications: centre.settings.comparison_replications });
    return { ...result, computeMs: Math.round(performance.now() - t0) };
  });
}
