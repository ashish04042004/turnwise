/**
 * Pure planning functions. No I/O: callers load a snapshot of the centre,
 * plan against it, and then commit through the database, whose exclusion
 * constraints reject any plan that became stale in the meantime.
 *
 * Shapes (all times are epoch milliseconds):
 *   Interval  { start, end }
 *   Resource  { id, name, capabilities: string[], active }
 *   Step      { stepId, visitId, label, durationMin, requirements: string[],
 *               earliest, priority, orderKey, preferredResourceIds?, prereqs: [{ stepId, minGapMin }] }
 *   State     { horizonEnd, granularityMs, resources,
 *               resourceBusy: Map<resourceId, Interval[]>,
 *               visitBusy: Map<visitId, Interval[]>,
 *               fixedStepEnds: Map<stepId, end> }
 *   Placement { stepId, visitId, start, end, resourceIds }
 */

export const overlaps = (a, b) => a.start < b.end && b.start < a.end;

const isFree = (busy, slot) => !busy || busy.every((b) => !overlaps(b, slot));

const roundUp = (t, step) => Math.ceil(t / step) * step;

export function cloneState(state) {
  const copy = (m) => new Map([...m].map(([k, v]) => [k, [...v]]));
  return {
    ...state,
    resourceBusy: copy(state.resourceBusy),
    visitBusy: copy(state.visitBusy),
    fixedStepEnds: new Map(state.fixedStepEnds),
  };
}

/** Assigns one distinct free resource to every requirement (small bipartite match). */
function assignResources(requirements, slot, state, preferred) {
  const candidatesFor = (cap) =>
    state.resources
      .filter((r) => r.active && r.capabilities.includes(cap) && isFree(state.resourceBusy.get(r.id), slot))
      .sort((a, b) => {
        const pa = preferred.includes(a.id) ? 0 : 1;
        const pb = preferred.includes(b.id) ? 0 : 1;
        return pa - pb || a.name.localeCompare(b.name);
      })
      .map((r) => r.id);

  const options = requirements.map(candidatesFor);
  // Scarcest requirement first keeps backtracking tiny.
  const order = requirements.map((_, i) => i).sort((a, b) => options[a].length - options[b].length);
  const chosen = new Array(requirements.length);
  const used = new Set();

  const solve = (k) => {
    if (k === order.length) return true;
    const idx = order[k];
    for (const rid of options[idx]) {
      if (used.has(rid)) continue;
      used.add(rid);
      chosen[idx] = rid;
      if (solve(k + 1)) return true;
      used.delete(rid);
    }
    return false;
  };
  return solve(0) ? chosen : null;
}

/** Explains why a step can never be placed regardless of time. */
export function structuralBlocker(step, state) {
  const active = state.resources.filter((r) => r.active);
  for (const cap of new Set(step.requirements)) {
    const needed = step.requirements.filter((c) => c === cap).length;
    const available = active.filter((r) => r.capabilities.includes(cap)).length;
    if (available < needed) {
      return available === 0
        ? `No active resource can provide "${cap}"`
        : `Needs ${needed} × "${cap}" but only ${available} active`;
    }
  }
  return null;
}

/**
 * Earliest start >= `earliest` at which the patient and a full set of
 * compatible resources are simultaneously free for the whole duration.
 * Only `earliest` and the ends of busy intervals can be earliest feasible
 * starts, so checking those candidates is exact.
 */
export function findEarliestSlot(step, state, earliest) {
  const duration = step.durationMin * 60_000;
  const relevant = state.resources.filter((r) => r.capabilities.some((c) => step.requirements.includes(c)));
  const g = state.granularityMs;
  const lower = roundUp(earliest, g);

  const candidates = new Set([lower]);
  for (const r of relevant) {
    for (const b of state.resourceBusy.get(r.id) ?? []) if (b.end > lower) candidates.add(roundUp(b.end, g));
  }
  for (const b of state.visitBusy.get(step.visitId) ?? []) if (b.end > lower) candidates.add(roundUp(b.end, g));

  for (const start of [...candidates].sort((a, b) => a - b)) {
    const slot = { start, end: start + duration };
    if (slot.end > state.horizonEnd) return null;
    if (!isFree(state.visitBusy.get(step.visitId), slot)) continue;
    const resourceIds = assignResources(step.requirements, slot, state, step.preferredResourceIds ?? []);
    if (resourceIds) return { stepId: step.stepId, visitId: step.visitId, ...slot, resourceIds };
  }
  return null;
}

function commitToState(state, p) {
  const slot = { start: p.start, end: p.end };
  for (const rid of p.resourceIds) state.resourceBusy.set(rid, [...(state.resourceBusy.get(rid) ?? []), slot]);
  state.visitBusy.set(p.visitId, [...(state.visitBusy.get(p.visitId) ?? []), slot]);
  state.fixedStepEnds.set(p.stepId, p.end);
}

const rank = (a, b) => b.priority - a.priority || a.orderKey - b.orderKey || a.stepId.localeCompare(b.stepId);

/**
 * List scheduling: repeatedly takes the highest-ranked step whose
 * prerequisites are resolved and places it at its earliest feasible slot.
 * Does not mutate its inputs; returns placements and explicit failures.
 */
export function planSteps(steps, initial) {
  const state = cloneState(initial);
  const placements = [];
  const unplaced = [];
  const pending = [...steps].sort(rank);
  const movingIds = new Set(steps.map((s) => s.stepId));
  const failed = new Set();

  while (pending.length > 0) {
    const idx = pending.findIndex((s) =>
      s.prereqs.every((p) => !movingIds.has(p.stepId) || state.fixedStepEnds.has(p.stepId) || failed.has(p.stepId)),
    );
    if (idx === -1) {
      for (const s of pending.splice(0)) unplaced.push({ stepId: s.stepId, visitId: s.visitId, reason: 'Circular prerequisites' });
      break;
    }
    const step = pending.splice(idx, 1)[0];

    if (step.prereqs.some((p) => failed.has(p.stepId))) {
      failed.add(step.stepId);
      unplaced.push({ stepId: step.stepId, visitId: step.visitId, reason: 'A prerequisite step could not be scheduled' });
      continue;
    }

    const structural = structuralBlocker(step, state);
    if (structural) {
      failed.add(step.stepId);
      unplaced.push({ stepId: step.stepId, visitId: step.visitId, reason: structural });
      continue;
    }

    let earliest = step.earliest;
    for (const p of step.prereqs) {
      const end = state.fixedStepEnds.get(p.stepId);
      if (end !== undefined) earliest = Math.max(earliest, end + p.minGapMin * 60_000);
    }

    const placement = findEarliestSlot(step, state, earliest);
    if (!placement) {
      failed.add(step.stepId);
      unplaced.push({ stepId: step.stepId, visitId: step.visitId, reason: 'No feasible slot before closing time' });
      continue;
    }
    commitToState(state, placement);
    placements.push(placement);
  }

  return { placements, unplaced, state };
}
