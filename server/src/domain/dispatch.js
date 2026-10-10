/**
 * "Next up": which waiting patient staff should call now. Pure; the board
 * feeds it a snapshot.
 *
 * Order is by when each patient was due (an appointment's booked time, a
 * walk-in's arrival), not by the plan. Following the plan lets early-arriving
 * appointments jump ahead of walk-ins who are already waiting, which the
 * policy comparison showed nearly doubles the walk-in 90th-percentile wait.
 *
 * A suggestion never takes a resource that is down, in use, held, or booked
 * for someone due before this step, the same rules Start enforces without
 * forcing. It may push later bookings (reported as `bumps`), because once
 * services overrun, a strict "move nobody" rule would leave the list empty
 * exactly when the floor is busiest. Options that move nobody come first
 * (booked resources, else interchangeable free ones, as late binding does);
 * pushing is only considered on the booked resources, because Start only
 * swaps to resources that are completely free. Each patient and each
 * resource gets at most one suggestion.
 *
 * candidates: [{ stepId, visitId, patient, service, requirements, durationMs,
 *                reservedResourceIds, dueAt, plannedStart, kind,
 *                ownBusy: [{ start, end, stepId }] (the patient's other booked
 *                steps; overlapping one moves it, as Start does) }]
 * busy:       Map<resourceId, [{ start, end, stepId, hard }]>
 *             hard = cannot be pushed (downtime, in use, held)
 */
import { candidateOptions, matchRequirements, overlaps } from './scheduler.js';

export function suggestNextUp({ now, resources, busy, candidates }) {
  const claimedResources = new Set();
  const claimedVisits = new Set();
  const suggestions = [];

  const ordered = [...candidates].sort(
    (a, b) => a.dueAt - b.dueAt || (a.plannedStart ?? 0) - (b.plannedStart ?? 0) || a.stepId.localeCompare(b.stepId),
  );
  for (const c of ordered) {
    if (claimedVisits.has(c.visitId)) continue;
    const slot = { start: now, end: now + c.durationMs };

    const clashes = (r) => (busy.get(r.id) ?? []).filter((b) => b.stepId !== c.stepId && overlaps(b, slot));
    const pushable = (b) => !b.hard && b.stepId && c.plannedStart != null && b.start >= c.plannedStart;
    const available = (r) => r.active && !claimedResources.has(r.id);
    const resourceIds =
      matchRequirements(candidateOptions(c.requirements, resources, (r) => available(r) && clashes(r).length === 0, c.reservedResourceIds)) ??
      matchRequirements(
        candidateOptions(c.requirements, resources, (r) => available(r) && c.reservedResourceIds.includes(r.id) && clashes(r).every(pushable), c.reservedResourceIds),
      );
    if (!resourceIds) continue;

    const bumped = new Set([
      ...resources.filter((r) => resourceIds.includes(r.id)).flatMap((r) => clashes(r).map((b) => b.stepId)),
      ...(c.ownBusy ?? []).filter((b) => overlaps(b, slot)).map((b) => b.stepId),
    ]);
    for (const id of resourceIds) claimedResources.add(id);
    claimedVisits.add(c.visitId);
    suggestions.push({
      stepId: c.stepId,
      visitId: c.visitId,
      patient: c.patient,
      service: c.service,
      kind: c.kind,
      dueAt: c.dueAt,
      plannedStart: c.plannedStart,
      bookedTimeReached: c.plannedStart != null && c.plannedStart <= now,
      waitingMin: Math.max(0, Math.round((now - c.dueAt) / 60_000)),
      resourceIds,
      swapped: resourceIds.some((id) => !c.reservedResourceIds.includes(id)),
      bumps: bumped.size,
    });
  }
  return suggestions;
}
