/**
 * Simulates the rest of the day forward from `now` using live progress.
 * Committed plans are not changed here; this is the estimate shown to staff
 * and patients. A step cannot start before its planned time, before now,
 * before its resources are projected to be free, or while its patient is
 * still in another step.
 *
 * steps: [{ stepId, visitId, status: 'scheduled' | 'in_service', plannedStart,
 *           plannedEnd, actualStart?, expectedMin, resourceIds }]
 * returns Map<stepId, { start, end, delayMin }>
 */
export function projectSchedule(steps, now) {
  const out = new Map();
  const resourceFree = new Map();
  const visitFree = new Map();
  const bump = (m, k, t) => m.set(k, Math.max(m.get(k) ?? 0, t));

  const ordered = [...steps].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'in_service' ? -1 : 1;
    return a.plannedStart - b.plannedStart || a.stepId.localeCompare(b.stepId);
  });

  for (const s of ordered) {
    let start;
    let end;
    if (s.status === 'in_service') {
      start = s.actualStart ?? s.plannedStart;
      end = Math.max(start + s.expectedMin * 60_000, now + 60_000);
    } else {
      start = Math.max(s.plannedStart, now, visitFree.get(s.visitId) ?? 0, ...s.resourceIds.map((r) => resourceFree.get(r) ?? 0));
      end = start + s.expectedMin * 60_000;
    }
    for (const r of s.resourceIds) bump(resourceFree, r, end);
    bump(visitFree, s.visitId, end);
    out.set(s.stepId, { start, end, delayMin: Math.max(0, Math.round((start - s.plannedStart) / 60_000)) });
  }
  return out;
}

/** Blends configured duration with observed history; few samples lean on configuration. */
export function expectedDuration(configuredMin, observedMeanMin, samples, priorWeight = 5) {
  if (!observedMeanMin || !samples) return configuredMin;
  return (configuredMin * priorWeight + observedMeanMin * samples) / (priorWeight + samples);
}

/**
 * Turns a point estimate into a range calibrated by how wrong past estimates
 * were (p80 absolute error), clamped to something a person can act on.
 */
export function waitRange(waitMin, p80AbsErrorMin) {
  const band = Math.min(30, Math.max(3, p80AbsErrorMin ?? 5));
  const low = Math.max(0, Math.floor((waitMin - band / 2) / 5) * 5);
  const high = Math.max(low + 5, Math.ceil((waitMin + band) / 5) * 5);
  return { low, high };
}
