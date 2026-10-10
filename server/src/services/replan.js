import { badRequest, conflict, isCapacityConflict, lockCentrePlanning, notFound, pool, withTx } from '../db.js';
import { notifyPatient, recordEvent } from '../events.js';
import { planSteps } from '../domain/scheduler.js';
import { buildPlannerState, loadSnapshot, toPlannerStep } from './context.js';
import { persistPlacement, releaseStepReservations } from './persist.js';
import { fmtTime } from './booking.js';

class StaleProposalError extends Error {}

/**
 * Takes steps off the schedule because their reservation can no longer be
 * honoured (resource down, overrun, late start). The step keeps its old
 * planned time for reference and waits for a staff-approved re-plan.
 * Unconfirmed holds that get hit are simply revoked.
 */
export async function displaceSteps(tx, centreId, stepIds, reason, actor) {
  if (stepIds.length === 0) return [];
  const { rows } = await tx.query(
    `SELECT s.id, s.status, s.visit_id, v.status AS visit_status, p.name AS patient, sv.code AS service
     FROM visit_steps s JOIN visits v ON v.id = s.visit_id JOIN patients p ON p.id = v.patient_id
     JOIN services sv ON sv.id = s.service_id
     WHERE s.id = ANY($1) ORDER BY s.id FOR UPDATE OF s`,
    [stepIds],
  );
  const displaced = [];
  for (const s of rows) {
    if (s.status !== 'scheduled' && s.status !== 'in_service') continue;
    if (s.visit_status === 'held') {
      const { rows: siblings } = await tx.query(`SELECT id FROM visit_steps WHERE visit_id = $1`, [s.visit_id]);
      await releaseStepReservations(tx, siblings.map((x) => x.id), 'expired');
      await tx.query(`UPDATE visit_steps SET status = 'cancelled', version = version + 1 WHERE visit_id = $1 AND status <> 'cancelled'`, [s.visit_id]);
      await tx.query(`UPDATE visits SET status = 'expired' WHERE id = $1`, [s.visit_id]);
      await tx.query(
        `UPDATE waitlist_entries SET status = 'waiting', offered_visit_id = NULL, offer_expires_at = NULL
         WHERE offered_visit_id = $1 AND status = 'offered'`,
        [s.visit_id],
      );
      await recordEvent(tx, centreId, 'hold.revoked', s.visit_id, { patient: s.patient, reason }, actor);
      continue;
    }
    await releaseStepReservations(tx, [s.id]);
    await tx.query(`UPDATE visit_steps SET status = 'displaced', actual_start = NULL, version = version + 1 WHERE id = $1`, [s.id]);
    if (s.status === 'in_service') await tx.query(`UPDATE visits SET status = 'arrived' WHERE id = $1 AND status = 'in_progress'`, [s.visit_id]);
    await recordEvent(tx, centreId, 'step.displaced', s.id, { patient: s.patient, service: s.service, reason, wasInService: s.status === 'in_service' }, actor);
    displaced.push({ stepId: s.id, visitId: s.visit_id, patient: s.patient, service: s.service });
  }
  return displaced;
}

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

function withDependents(snap, ids) {
  const set = new Set(ids);
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of snap.steps) {
      if (set.has(s.id) || s.status !== 'scheduled') continue;
      const deps = toPlannerStep(snap, s, { earliest: 0 }).prereqs;
      if (deps.some((d) => set.has(d.stepId))) {
        set.add(s.id);
        grew = true;
      }
    }
  }
  return set;
}

function describeOption(snap, { key, title, summary }, plan) {
  const resName = new Map(snap.resources.map((r) => [r.id, r.name]));
  const stepById = new Map(snap.steps.map((s) => [s.id, s]));
  const base = (s) => ({
    stepId: s.id,
    visitId: s.visit_id,
    version: s.version,
    patient: s.patient_name,
    service: snap.services.get(s.service_id).code,
    wasDisplaced: s.status === 'displaced',
  });

  const moves = plan.placements.flatMap((p) => {
    const s = stepById.get(p.stepId);
    const fromRes = snap.stepResources.get(s.id) ?? snap.previousResources.get(s.id) ?? [];
    const fromStart = s.planned_start?.getTime() ?? null;
    if (s.status !== 'displaced' && fromStart === p.start && sameSet(fromRes, p.resourceIds)) return [];
    return [
      {
        ...base(s),
        from: fromStart
          ? { start: s.planned_start.toISOString(), end: s.planned_end.toISOString(), resources: fromRes.map((id) => resName.get(id)) }
          : null,
        to: {
          start: new Date(p.start).toISOString(),
          end: new Date(p.end).toISOString(),
          resourceIds: p.resourceIds,
          resources: p.resourceIds.map((id) => resName.get(id)),
        },
        delayMin: fromStart ? Math.round((p.start - fromStart) / 60_000) : 0,
      },
    ];
  });
  const unschedulable = plan.unplaced.map((u) => ({ ...base(stepById.get(u.stepId)), reason: u.reason }));
  const delays = moves.map((m) => Math.max(0, m.delayMin));
  return {
    key,
    title,
    summary,
    moves,
    unschedulable,
    metrics: {
      patientsAffected: new Set([...moves, ...unschedulable].map((x) => x.visitId)).size,
      stepsMoved: moves.length,
      totalDelayMin: delays.reduce((a, b) => a + b, 0),
      maxDelayMin: delays.length ? Math.max(...delays) : 0,
      unschedulable: unschedulable.length,
    },
  };
}

/**
 * Computes alternative feasible schedules for every displaced step:
 *  - "contain": only affected steps move; every other booking stays put.
 *  - "shift": later bookings on the same kind of resource shift down so the
 *    original queue order is preserved (fairer, but touches more patients).
 */
export function buildOptions(snap) {
  const now = snap.clock.now;
  const displaced = snap.steps.filter((s) => s.status === 'displaced');
  const earliestFor = (s) => (s.arrived_at ? now : Math.max(now, (s.planned_start ?? s.scheduled_at ?? new Date(now)).getTime()));

  const plan = (moving) => {
    const steps = snap.steps.filter((s) => moving.has(s.id));
    return planSteps(
      steps.map((s) => toPlannerStep(snap, s, { earliest: earliestFor(s), preferResources: true })),
      buildPlannerState(snap, moving),
    );
  };

  const containSet = withDependents(snap, displaced.map((s) => s.id));
  const options = [
    describeOption(
      snap,
      { key: 'contain', title: 'Move only affected patients', summary: 'Every other booking keeps its time and resources.' },
      plan(containSet),
    ),
  ];

  const caps = new Set(displaced.flatMap((s) => snap.services.get(s.service_id).requirements));
  const from = Math.min(...displaced.map((s) => s.planned_start?.getTime() ?? now));
  const followers = snap.steps.filter(
    (s) =>
      s.status === 'scheduled' &&
      s.visit_status !== 'held' &&
      s.planned_start &&
      s.planned_start.getTime() >= Math.max(now, from) &&
      snap.services.get(s.service_id).requirements.some((c) => caps.has(c)),
  );
  if (followers.length > 0) {
    const shiftSet = withDependents(snap, [...containSet, ...followers.map((s) => s.id)]);
    const shift = describeOption(
      snap,
      { key: 'shift', title: 'Shift the queue, keep arrival order', summary: 'Later bookings on the same equipment move back so nobody jumps the queue.' },
      plan(shiftSet),
    );
    // Shifting must never strand a patient who currently has a valid booking.
    const strandsSomeone = shift.unschedulable.some((u) => !u.wasDisplaced);
    const identical =
      shift.moves.length === options[0].moves.length &&
      shift.moves.every((m) => options[0].moves.some((o) => o.stepId === m.stepId && o.to.start === m.to.start));
    if (!strandsSomeone && !identical) options.push(shift);
  }

  // Prefer stranding nobody, then the smallest worst-case delay for any one patient.
  options.sort(
    (a, b) =>
      a.metrics.unschedulable - b.metrics.unschedulable ||
      a.metrics.maxDelayMin - b.metrics.maxDelayMin ||
      a.metrics.totalDelayMin - b.metrics.totalDelayMin,
  );
  options.forEach((o, i) => (o.recommended = i === 0));
  return options;
}

/** Replaces any pending proposal with fresh options for all displaced steps. */
export async function generateProposal(centre, trigger, actor = 'system') {
  return withTx(async (tx) => {
    await lockCentrePlanning(tx, centre.id);
    const { rows: superseded } = await tx.query(
      `UPDATE replan_proposals SET status = 'superseded', decided_at = now() WHERE centre_id = $1 AND status = 'pending' RETURNING trigger`,
      [centre.id],
    );
    const snap = await loadSnapshot(tx, centre);
    if (!snap.steps.some((s) => s.status === 'displaced')) return null;
    // The new proposal also covers whatever the superseded one was about.
    const causes = [...new Set([...superseded.flatMap((p) => p.trigger.split(' · ')), trigger])].filter((t) => t !== 'Previous proposal went stale');
    trigger = causes.slice(-3).join(' · ') || trigger;
    const options = buildOptions(snap);
    const { rows } = await tx.query(
      `INSERT INTO replan_proposals (centre_id, trigger, status, options) VALUES ($1, $2, 'pending', $3) RETURNING id, created_at`,
      [centre.id, trigger, JSON.stringify(options)],
    );
    await recordEvent(tx, centre.id, 'replan.proposed', rows[0].id, { trigger, options: options.map((o) => ({ key: o.key, ...o.metrics })) }, actor);
    return { id: rows[0].id, trigger, options };
  });
}

/**
 * Commits a staff-approved option atomically. If anything changed since the
 * proposal was computed (version mismatch, or the exclusion constraint finds
 * an overlap), nothing is applied and a fresh proposal is generated.
 */
export async function applyProposal(centre, proposalId, optionKey, actor) {
  try {
    return await withTx(async (tx) => {
      await lockCentrePlanning(tx, centre.id);
      const { rows } = await tx.query(`SELECT * FROM replan_proposals WHERE id = $1 AND centre_id = $2 FOR UPDATE`, [proposalId, centre.id]);
      const proposal = rows[0];
      if (!proposal) throw notFound('Proposal');
      if (proposal.status !== 'pending') throw conflict(`This proposal is already ${proposal.status}`);
      const option = proposal.options.find((o) => o.key === optionKey);
      if (!option) throw badRequest(`Unknown option ${optionKey}`);

      const ids = option.moves.map((m) => m.stepId);
      const { rows: current } = await tx.query(`SELECT id, version, status FROM visit_steps WHERE id = ANY($1) ORDER BY id FOR UPDATE`, [ids]);
      for (const m of option.moves) {
        const row = current.find((c) => c.id === m.stepId);
        if (!row || row.version !== m.version || !['displaced', 'scheduled'].includes(row.status)) throw new StaleProposalError();
      }

      await releaseStepReservations(tx, ids);
      // Off the patient-overlap constraint while siblings swap places.
      await tx.query(`UPDATE visit_steps SET status = 'displaced' WHERE id = ANY($1)`, [ids]);
      for (const m of option.moves) {
        await persistPlacement(
          tx,
          centre.id,
          { stepId: m.stepId, visitId: m.visitId, start: Date.parse(m.to.start), end: Date.parse(m.to.end), resourceIds: m.to.resourceIds },
          'confirmed',
        );
      }
      await tx.query(
        `UPDATE replan_proposals SET status = 'applied', chosen_option = $2, decided_by = $3, decided_at = now() WHERE id = $1`,
        [proposalId, optionKey, actor],
      );
      await recordEvent(
        tx,
        centre.id,
        'replan.applied',
        proposalId,
        { option: optionKey, moved: option.moves.length, unschedulable: option.unschedulable.length, decisionSec: Math.round((Date.now() - new Date(proposal.created_at).getTime()) / 1000) },
        actor,
      );

      const { rows: contacts } = await tx.query(
        `SELECT v.id, p.name, p.phone FROM visits v JOIN patients p ON p.id = v.patient_id WHERE v.id = ANY($1)`,
        [[...new Set(option.moves.map((m) => m.visitId))]],
      );
      for (const m of option.moves) {
        const c = contacts.find((x) => x.id === m.visitId);
        await notifyPatient(tx, centre.id, {
          visitId: m.visitId,
          phone: c.phone,
          name: c.name,
          message: `Update from ${centre.name}: your ${m.service} is now at ${fmtTime(m.to.start, centre.timezone)} (${m.to.resources.join(', ')}).`,
          key: `replan:${proposalId}:${m.stepId}`,
        });
      }
      return { applied: option.moves.length, unschedulable: option.unschedulable };
    });
  } catch (err) {
    if (err instanceof StaleProposalError || isCapacityConflict(err)) {
      await pool.query(`UPDATE replan_proposals SET status = 'stale', decided_at = now() WHERE id = $1 AND status = 'pending'`, [proposalId]);
      const fresh = await generateProposal(centre, 'Previous proposal went stale', actor);
      throw conflict('The centre changed since this plan was computed. A fresh proposal is ready.', { proposalId: fresh?.id ?? null });
    }
    throw err;
  }
}

export async function rejectProposal(centre, proposalId, actor) {
  const { rowCount } = await pool.query(
    `UPDATE replan_proposals SET status = 'rejected', decided_by = $3, decided_at = now()
     WHERE id = $1 AND centre_id = $2 AND status = 'pending'`,
    [proposalId, centre.id, actor],
  );
  if (!rowCount) throw conflict('Proposal is no longer pending');
  await recordEvent(pool, centre.id, 'replan.rejected', proposalId, {}, actor);
}

/** Marks a resource unavailable now, displacing every booking that needed it. */
export async function markResourceDown(centre, resourceId, minutes, reason, actor) {
  const result = await withTx(async (tx) => {
    const { rows } = await tx.query(`SELECT * FROM resources WHERE id = $1 AND centre_id = $2 FOR UPDATE`, [resourceId, centre.id]);
    const resource = rows[0];
    if (!resource) throw notFound('Resource');
    const { rows: existing } = await tx.query(
      `SELECT upper(during) AS until FROM reservations
       WHERE resource_id = $1 AND kind = 'downtime' AND status = 'confirmed' AND during @> now()`,
      [resourceId],
    );
    if (existing.length) throw conflict(`${resource.name} is already unavailable until ${fmtTime(existing[0].until, centre.timezone)}`);

    const { rows: hits } = await tx.query(
      `SELECT DISTINCT step_id FROM reservations
       WHERE resource_id = $1 AND kind = 'service' AND status IN ('held', 'confirmed', 'in_use')
         AND during && tstzrange(now(), now() + make_interval(mins => $2), '[)')`,
      [resourceId, minutes],
    );
    const displaced = await displaceSteps(tx, centre.id, hits.map((h) => h.step_id), `${resource.name} unavailable`, actor);
    const { rows: dt } = await tx.query(
      `INSERT INTO reservations (centre_id, resource_id, kind, status, during, reason)
       VALUES ($1, $2, 'downtime', 'confirmed', tstzrange(now(), now() + make_interval(mins => $3), '[)'), $4)
       RETURNING id, upper(during) AS until`,
      [centre.id, resourceId, minutes, reason],
    );
    await recordEvent(tx, centre.id, 'resource.down', resourceId, { resource: resource.name, until: dt[0].until, reason, displaced: displaced.length }, actor);
    return { resource: resource.name, until: dt[0].until, displaced };
  });
  const proposal = await generateProposal(centre, `${result.resource} unavailable for ${minutes} min${reason ? ` (${reason})` : ''}`, actor);
  return { ...result, proposalId: proposal?.id ?? null };
}

/** Ends an outage early; displaced patients may now have better options. */
export async function markResourceUp(centre, resourceId, actor) {
  const name = await withTx(async (tx) => {
    const { rows } = await tx.query(`SELECT name FROM resources WHERE id = $1 AND centre_id = $2 FOR UPDATE`, [resourceId, centre.id]);
    if (!rows[0]) throw notFound('Resource');
    const { rowCount } = await tx.query(
      `UPDATE reservations SET status = 'completed', during = tstzrange(lower(during), greatest(now(), lower(during) + interval '1 second'), '[)')
       WHERE resource_id = $1 AND kind = 'downtime' AND status = 'confirmed' AND upper(during) > now()`,
      [resourceId],
    );
    if (!rowCount) throw conflict(`${rows[0].name} is not currently marked unavailable`);
    await recordEvent(tx, centre.id, 'resource.up', resourceId, { resource: rows[0].name }, actor);
    return rows[0].name;
  });
  const proposal = await generateProposal(centre, `${name} back in service`, actor);
  return { proposalId: proposal?.id ?? null };
}
