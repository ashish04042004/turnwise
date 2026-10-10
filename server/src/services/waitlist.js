import { randomUUID } from 'node:crypto';
import { badRequest, HttpError, lockCentrePlanning, retryOnConflict, withTx } from '../db.js';
import { notifyPatient, recordEvent } from '../events.js';
import { planSteps } from '../domain/scheduler.js';
import { buildPlannerState, getCentre, loadSnapshot, newVisitSteps } from './context.js';
import { confirmHeldVisit, expireHolds } from './booking.js';
import { fmtTime, renderMessage } from './messages.js';
import { insertPatient, insertStep, insertVisit, persistPlacement } from './persist.js';

export async function addToWaitlist(centre, { patient, serviceIds, earliest, latest }, actor) {
  if (latest <= earliest) throw badRequest('latest must be after earliest');
  return withTx(async (tx) => {
    const { rows: known } = await tx.query(`SELECT id FROM services WHERE centre_id = $1 AND id = ANY($2) AND active`, [centre.id, serviceIds]);
    if (known.length !== serviceIds.length) throw badRequest('Unknown or retired service');
    const patientId = await insertPatient(tx, centre.id, patient);
    const { rows } = await tx.query(
      `INSERT INTO waitlist_entries (centre_id, patient_id, service_ids, earliest, latest, status)
       VALUES ($1, $2, $3, $4, $5, 'waiting') RETURNING id`,
      [centre.id, patientId, serviceIds, earliest, latest],
    );
    await recordEvent(tx, centre.id, 'waitlist.added', rows[0].id, { patient: patient.name }, actor);
    return { id: rows[0].id };
  });
}

/**
 * Offers a just-released opening to the longest-waiting eligible patient by
 * placing a hold on it. When driven from the outbox, the outbox row is marked
 * processed in the same transaction as the offer, so a retried job after a
 * crash finds it already done instead of making a second offer.
 */
export async function recoverCapacity(centreId, release, outboxId = null) {
  const centre = await getCentre(centreId);
  return retryOnConflict(() =>
    withTx(async (tx) => {
      if (outboxId != null) {
        const { rowCount } = await tx.query(
          `UPDATE outbox SET status = 'delivered', delivered_at = now(), last_error = NULL WHERE id = $1 AND status <> 'delivered'`,
          [outboxId],
        );
        if (!rowCount) return { offered: false, reason: 'Already processed' };
      }
      await lockCentrePlanning(tx, centre.id);
      await expireHolds(tx, centre.id);
      const snap = await loadSnapshot(tx, centre);
      const gapStart = Math.max(Date.parse(release.start), snap.clock.now + centre.offer_lead_minutes * 60_000);
      const gapEnd = Date.parse(release.end);
      if (gapStart >= gapEnd) return { offered: false, reason: 'Opening is too soon for anyone to travel in' };

      const { rows: entries } = await tx.query(
        `SELECT w.*, p.name, p.phone FROM waitlist_entries w JOIN patients p ON p.id = w.patient_id
         WHERE w.centre_id = $1 AND w.status = 'waiting' AND w.latest > $2 AND w.earliest < $3
           AND (w.last_offer_expired_at IS NULL OR w.last_offer_expired_at < now() - make_interval(mins => $4))
         ORDER BY w.created_at
         FOR UPDATE OF w`,
        [centre.id, new Date(gapStart), new Date(gapEnd), centre.settings.waitlist_offer_cooldown_min],
      );
      const state = buildPlannerState(snap, new Set());
      for (const e of entries) {
        // A service retired since they joined can't be offered; they stay on the list for staff to rebook.
        if (e.service_ids.some((id) => !snap.services.get(id)?.active)) continue;
        const visitId = randomUUID();
        const steps = newVisitSteps(snap, {
          visitId,
          serviceIds: e.service_ids,
          earliest: Math.max(gapStart, e.earliest.getTime()),
          priority: 0,
          label: e.name,
        });
        const plan = planSteps(steps, state);
        if (plan.unplaced.length > 0) continue;
        const first = Math.min(...plan.placements.map((p) => p.start));
        const last = Math.max(...plan.placements.map((p) => p.end));
        if (first >= gapEnd || last > e.latest.getTime()) continue;

        const expiresAt = new Date(snap.clock.now + centre.offer_ttl_seconds * 1000);
        const { public_token } = await insertVisit(tx, {
          id: visitId,
          centreId: centre.id,
          patientId: e.patient_id,
          kind: 'appointment',
          status: 'held',
          scheduledAt: new Date(first),
          arrivedAt: null,
          priority: 0,
          source: 'waitlist',
        });
        for (const s of steps) await insertStep(tx, { id: s.stepId, visitId, serviceId: s.serviceId, status: 'unscheduled' });
        for (const p of plan.placements) await persistPlacement(tx, centre.id, p, 'held', expiresAt);
        await tx.query(
          `UPDATE waitlist_entries SET status = 'offered', offered_visit_id = $2, offer_expires_at = $3,
             capacity_released_at = $4, offers_made = offers_made + 1
           WHERE id = $1`,
          [e.id, visitId, expiresAt, release.releasedAt ? new Date(release.releasedAt) : new Date(snap.clock.now)],
        );
        await recordEvent(tx, centre.id, 'waitlist.offered', e.id, { patient: e.name, start: new Date(first), visitId, reason: release.reason });
        await notifyPatient(tx, centre.id, {
          visitId,
          phone: e.phone,
          name: e.name,
          message: renderMessage(centre, 'waitlist.offer', {
            time: fmtTime(first, centre),
            minutes: Math.round(centre.offer_ttl_seconds / 60),
            link: `/p/${public_token}`,
          }),
          key: `offer:${visitId}`,
        });
        return { offered: true, waitlistEntryId: e.id, visitId };
      }
      await recordEvent(tx, centre.id, 'capacity.unclaimed', null, { start: new Date(gapStart), end: new Date(gapEnd), candidates: entries.length });
      return { offered: false, reason: 'No eligible waitlisted patient fits this opening' };
    }),
  );
}

async function offerByToken(tx, token) {
  const { rows } = await tx.query(
    `SELECT v.id AS visit_id, v.centre_id, w.id AS entry_id, w.capacity_released_at, w.status
     FROM visits v JOIN waitlist_entries w ON w.offered_visit_id = v.id
     WHERE v.public_token = $1 FOR UPDATE OF w`,
    [token],
  );
  if (!rows[0] || rows[0].status !== 'offered') throw new HttpError(410, 'offer_gone', 'This offer is no longer available');
  return rows[0];
}

export async function acceptOffer(token) {
  return withTx(async (tx) => {
    const offer = await offerByToken(tx, token);
    const centre = await getCentre(offer.centre_id);
    await confirmHeldVisit(tx, centre, offer.visit_id, 'patient');
    const { rows } = await tx.query(
      `UPDATE waitlist_entries SET status = 'booked', booked_at = now() WHERE id = $1
       RETURNING extract(epoch FROM booked_at - capacity_released_at) / 60 AS recovery_min`,
      [offer.entry_id],
    );
    await recordEvent(tx, centre.id, 'waitlist.booked', offer.entry_id, { visitId: offer.visit_id, recoveryMin: Math.round(rows[0].recovery_min ?? 0) }, 'patient');
    return { visitId: offer.visit_id };
  });
}

/** Declining ends the hold now; expiry then passes the opening to the next candidate. */
export async function declineOffer(token) {
  return withTx(async (tx) => {
    const offer = await offerByToken(tx, token);
    await tx.query(
      `UPDATE reservations SET hold_expires_at = now()
       WHERE status = 'held' AND step_id IN (SELECT id FROM visit_steps WHERE visit_id = $1)`,
      [offer.visit_id],
    );
    await recordEvent(tx, offer.centre_id, 'waitlist.declined', offer.entry_id, {}, 'patient');
    await expireHolds(tx, offer.centre_id);
    return { declined: true };
  });
}
