import { pool } from '../db.js';
import { percentile } from '../util.js';
import { getCentre, getClock } from './context.js';
import { latencySummary } from '../latency.js';

const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    mean: sorted.length ? round1(sorted.reduce((a, b) => a + b, 0) / sorted.length) : null,
    p50: round1(percentile(sorted, 50)),
    p90: round1(percentile(sorted, 90)),
    max: round1(sorted.at(-1) ?? null),
  };
}

function histogram(values, edges) {
  return edges.map((lo, i) => {
    const hi = edges[i + 1];
    return {
      bucket: hi === undefined ? `${lo}+` : `${lo}–${hi}`,
      count: values.filter((v) => v >= lo && (hi === undefined || v < hi)).length,
    };
  });
}

/** Operational metrics for today, all computed from the event history and actual timings. */
export async function getAnalytics(centreId) {
  const centre = await getCentre(pool, centreId);
  const clock = await getClock(pool, centre);
  const from = new Date(Math.min(clock.opensAt, clock.now));
  const args = [centre.id, from];

  const [counts, waits, util, estimates, disruptions, recovery, reliability, durations] = await Promise.all([
    pool.query(
      `SELECT count(*)::int AS visits,
              count(*) FILTER (WHERE kind = 'appointment')::int AS appointments,
              count(*) FILTER (WHERE kind = 'walk_in')::int AS walk_ins,
              count(*) FILTER (WHERE status = 'completed')::int AS completed,
              count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
              count(*) FILTER (WHERE status = 'no_show')::int AS no_shows
       FROM visits WHERE centre_id = $1 AND status NOT IN ('held', 'expired') AND COALESCE(scheduled_at, created_at) >= $2`,
      args,
    ),
    // Wait = first service start minus the later of arrival and booked time.
    pool.query(
      `SELECT v.kind, extract(epoch FROM min(s.actual_start) - GREATEST(v.arrived_at, COALESCE(v.scheduled_at, v.arrived_at))) / 60 AS wait_min
       FROM visits v JOIN visit_steps s ON s.visit_id = v.id
       WHERE v.centre_id = $1 AND v.arrived_at >= $2 AND s.actual_start IS NOT NULL
       GROUP BY v.id`,
      args,
    ),
    pool.query(
      `WITH win AS (SELECT tstzrange($2, now()) AS w)
       SELECT res.id, res.name, res.kind,
         COALESCE(sum(extract(epoch FROM upper(r.during * win.w) - lower(r.during * win.w)))
           FILTER (WHERE r.kind = 'service' AND r.status IN ('in_use', 'completed')), 0) / 60 AS busy_min,
         COALESCE(sum(extract(epoch FROM upper(r.during * win.w) - lower(r.during * win.w)))
           FILTER (WHERE r.kind = 'downtime' AND r.status IN ('confirmed', 'completed')), 0) / 60 AS down_min,
         extract(epoch FROM now() - $2) / 60 AS window_min
       FROM resources res CROSS JOIN win
       LEFT JOIN reservations r ON r.resource_id = res.id AND r.during && win.w
       WHERE res.centre_id = $1 AND res.active
       GROUP BY res.id, res.name, res.kind, res.sort_order, win.w
       ORDER BY res.sort_order, res.name`,
      args,
    ),
    pool.query(
      `WITH first_promise AS (
         SELECT DISTINCT ON (e.step_id) e.step_id, e.predicted_start FROM estimate_snapshots e ORDER BY e.step_id, e.made_at
       )
       SELECT extract(epoch FROM s.actual_start - fp.predicted_start) / 60 AS err_min
       FROM first_promise fp JOIN visit_steps s ON s.id = fp.step_id JOIN visits v ON v.id = s.visit_id
       WHERE v.centre_id = $1 AND s.actual_start >= $2`,
      args,
    ),
    pool.query(
      `SELECT count(*) FILTER (WHERE type = 'resource.down')::int AS downtimes,
              count(*) FILTER (WHERE type = 'step.displaced')::int AS displaced,
              count(*) FILTER (WHERE type = 'step.extended')::int AS overruns,
              count(*) FILTER (WHERE type = 'replan.proposed')::int AS proposals,
              count(*) FILTER (WHERE type = 'replan.applied')::int AS applied,
              avg((payload->>'decisionSec')::numeric) FILTER (WHERE type = 'replan.applied') AS mean_decision_sec
       FROM events WHERE centre_id = $1 AND created_at >= $2`,
      args,
    ),
    pool.query(
      `SELECT (SELECT count(*)::int FROM outbox WHERE centre_id = $1 AND topic = 'capacity.released' AND created_at >= $2) AS releases,
              count(*) FILTER (WHERE type = 'waitlist.offered')::int AS offers,
              count(*) FILTER (WHERE type = 'waitlist.booked')::int AS booked,
              count(*) FILTER (WHERE type = 'capacity.unclaimed')::int AS unclaimed,
              avg((payload->>'recoveryMin')::numeric) FILTER (WHERE type = 'waitlist.booked') AS mean_recovery_min
       FROM events WHERE centre_id = $1 AND created_at >= $2`,
      args,
    ),
    pool.query(
      `SELECT count(*) FILTER (WHERE status IN ('pending', 'dispatched'))::int AS pending,
              count(*) FILTER (WHERE status = 'delivered')::int AS delivered,
              count(*) FILTER (WHERE status = 'failed')::int AS failed,
              count(*) FILTER (WHERE status = 'delivered' AND attempts > 1)::int AS recovered_after_retry,
              COALESCE(sum(GREATEST(attempts - 1, 0)), 0)::int AS retries
       FROM outbox WHERE centre_id = $1 AND created_at >= $2`,
      args,
    ),
    pool.query(
      `SELECT sv.code, sv.name, sv.duration_min AS configured,
              avg(extract(epoch FROM s.actual_end - s.actual_start)) / 60 AS observed, count(s.id)::int AS n
       FROM services sv LEFT JOIN visit_steps s ON s.service_id = sv.id AND s.status = 'completed' AND s.actual_end >= $2
       WHERE sv.centre_id = $1 GROUP BY sv.id ORDER BY sv.category, sv.code`,
      args,
    ),
  ]);

  const waitAll = waits.rows.map((r) => Math.max(0, r.wait_min));
  const errs = estimates.rows.map((r) => r.err_min);
  const absErrs = errs.map(Math.abs);
  const d = disruptions.rows[0];
  const rc = recovery.rows[0];

  return {
    window: { from: from.toISOString(), to: new Date(clock.now).toISOString() },
    counts: counts.rows[0],
    waits: {
      all: distribution(waitAll),
      appointments: distribution(waits.rows.filter((r) => r.kind === 'appointment').map((r) => Math.max(0, r.wait_min))),
      walkIns: distribution(waits.rows.filter((r) => r.kind === 'walk_in').map((r) => Math.max(0, r.wait_min))),
      histogram: histogram(waitAll, [0, 5, 10, 15, 20, 30, 45, 60]),
      note: 'Only patients whose first service has started are counted; patients still waiting are excluded.',
    },
    utilization: util.rows.map((r) => {
      const available = Math.max(0, r.window_min - r.down_min);
      return {
        id: r.id,
        name: r.name,
        kind: r.kind,
        busyMin: Math.round(r.busy_min),
        downMin: Math.round(r.down_min),
        availableMin: Math.round(available),
        pct: available > 0 ? round1((100 * r.busy_min) / available) : null,
      };
    }),
    estimateAccuracy: {
      ...distribution(absErrs),
      biasMin: errs.length ? round1(errs.reduce((a, b) => a + b, 0) / errs.length) : null,
      note: 'Error = actual start minus the first start time promised (at check-in or walk-in). Positive bias means later than promised.',
    },
    disruptions: {
      downtimes: d.downtimes,
      overrunExtensions: d.overruns,
      displacedSteps: d.displaced,
      proposals: d.proposals,
      proposalsApplied: d.applied,
      meanDecisionSec: round1(d.mean_decision_sec),
    },
    recovery: {
      capacityReleases: rc.releases,
      offersMade: rc.offers,
      offersAccepted: rc.booked,
      unclaimed: rc.unclaimed,
      meanRecoveryMin: round1(rc.mean_recovery_min),
    },
    reliability: reliability.rows[0],
    serviceDurations: durations.rows.map((r) => ({ code: r.code, name: r.name, configuredMin: r.configured, observedMin: round1(r.observed), samples: r.n })),
    apiLatency: latencySummary(),
  };
}

export async function getEvents(centreId, { limit = 100, before } = {}) {
  const centre = await getCentre(pool, centreId);
  const { rows } = await pool.query(
    `SELECT id, type, subject_id, payload, actor, created_at FROM events
     WHERE centre_id = $1 AND ($2::bigint IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`,
    [centre.id, before ?? null, Math.min(limit, 500)],
  );
  return rows;
}
