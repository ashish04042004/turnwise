/**
 * Counterfactual comparison: replays the same demand with the same realised
 * service durations under two policies, so differences come from the policy
 * alone.
 *
 *   departmentQueues  Each patient does their tests in a fixed order and waits
 *                     first-come-first-served in each test's queue; only the
 *                     head of a queue can be served (a token system).
 *   turnwise          Appointments are reserved in advance and walk-ins are
 *                     planned on arrival with the real planner, which picks
 *                     test order and resources. On the floor, staff start a
 *                     ready step whose patient is present and whose booked
 *                     (or, with lateBinding, interchangeable) resources are
 *                     free. dispatch 'plan' takes the earliest-planned step;
 *                     'due' takes whoever was due first, as "Next up" does.
 *
 * Scenario (times are epoch ms):
 *   { open, close, granularityMs, lateBinding?, dispatch?: 'plan' | 'due',
 *     resources: [{ id, name, capabilities, active }],
 *     services: Map<code, { durationMin, requirements, order }>,
 *     prereqs: Map<code, [{ requires: code, minGapMin }]>,
 *     visits: [{ id, kind: 'appointment' | 'walk_in', arrival, scheduledAt?, codes }] }
 *
 * durations(visitId, code) -> realised minutes
 */
import { percentile } from '../util.js';
import { candidateOptions, matchRequirements, planSteps } from './scheduler.js';

const MIN = 60_000;

const matchResources = (requirements, resources, isFree, preferred = []) =>
  matchRequirements(candidateOptions(requirements, resources, (r) => isFree(r.id), preferred));

/** Earliest a test may begin given this visit's prerequisite tests (Infinity until they have finished). */
function prereqReady(scenario, code, ends, codes) {
  let t = 0;
  for (const p of scenario.prereqs.get(code) ?? []) {
    if (!codes.includes(p.requires)) continue;
    const end = ends.get(p.requires);
    t = end === undefined ? Infinity : Math.max(t, end + p.minGapMin * MIN);
  }
  return t;
}

export function simulateDepartmentQueues(scenario, durations) {
  const visits = scenario.visits.map((v) => ({
    ...v,
    remaining: [...v.codes].sort((a, b) => scenario.services.get(a).order - scenario.services.get(b).order),
    ends: new Map(),
    steps: [],
    busyUntil: v.arrival,
    readyAt: v.arrival,
    queued: false,
  }));
  const resourceFree = new Map(scenario.resources.map((r) => [r.id, 0]));
  const queues = new Map();
  let seq = 0;

  const enqueue = (v) => {
    const code = v.remaining[0];
    v.readyAt = Math.max(v.busyUntil, prereqReady(scenario, code, v.ends, v.codes));
    v.queued = true;
    v.seq = seq++;
    if (!queues.has(code)) queues.set(code, []);
    queues.get(code).push(v);
  };

  let t = Math.min(...visits.map((v) => v.arrival));
  for (let guard = 0; guard < 100_000; guard++) {
    for (const v of visits) {
      if (!v.queued && v.remaining.length > 0 && v.arrival <= t && v.busyUntil <= t) enqueue(v);
    }
    // Longest-waiting queue heads are served first; nobody behind a head can overtake it.
    for (let progress = true; progress; ) {
      progress = false;
      const heads = [...queues.values()].map((q) => q[0]).filter((v) => v && v.readyAt <= t);
      heads.sort((a, b) => a.readyAt - b.readyAt || a.seq - b.seq);
      for (const v of heads) {
        const code = v.remaining[0];
        const svc = scenario.services.get(code);
        const ids = matchResources(svc.requirements, scenario.resources, (id) => resourceFree.get(id) <= t);
        if (!ids) continue;
        const end = t + durations(v.id, code) * MIN;
        for (const id of ids) resourceFree.set(id, end);
        v.steps.push({ code, start: t, end, plannedStart: t });
        v.ends.set(code, end);
        v.busyUntil = end;
        v.remaining.shift();
        v.queued = false;
        queues.get(code).shift();
        progress = true;
      }
    }

    if (visits.every((v) => v.remaining.length === 0)) break;
    const future = [
      ...visits.filter((v) => v.remaining.length > 0 && v.arrival > t).map((v) => v.arrival),
      ...visits.filter((v) => v.busyUntil > t).map((v) => v.busyUntil),
      ...visits.filter((v) => v.queued && v.readyAt > t).map((v) => v.readyAt),
      ...[...resourceFree.values()].filter((f) => f > t),
    ].filter(Number.isFinite);
    if (future.length === 0) break;
    t = Math.min(...future);
  }
  return visits.map((v) => ({ id: v.id, kind: v.kind, arrival: v.arrival, steps: v.steps, unserved: v.remaining.length }));
}

export function simulateTurnwise(scenario, durations) {
  const visitsById = new Map(scenario.visits.map((v) => [v.id, v]));
  const g = scenario.granularityMs;
  const horizonEnd = scenario.close + 6 * 60 * MIN;
  const placements = [];
  const unplaced = [];
  const resourceFree = new Map();
  const visitFree = new Map();
  const visitEnds = new Map(scenario.visits.map((v) => [v.id, new Map()]));

  const plannerSteps = (v, earliest) => {
    const ids = new Map(v.codes.map((c) => [c, `${v.id}:${c}`]));
    return v.codes.map((code) => {
      const svc = scenario.services.get(code);
      return {
        stepId: ids.get(code),
        visitId: v.id,
        code,
        durationMin: svc.durationMin,
        requirements: svc.requirements,
        earliest,
        priority: 0,
        orderKey: earliest,
        prereqs: (scenario.prereqs.get(code) ?? []).filter((p) => ids.has(p.requires)).map((p) => ({ stepId: ids.get(p.requires), minGapMin: p.minGapMin })),
      };
    });
  };

  /** What the centre knows at `now`: started work at its real times (running work at its expected end), the rest as booked. */
  const stateAt = (now) => {
    const resourceBusy = new Map();
    const visitBusy = new Map();
    const fixedStepEnds = new Map();
    const push = (m, k, i) => m.set(k, [...(m.get(k) ?? []), i]);
    for (const p of placements) {
      let slot = { start: p.start, end: p.end };
      if (p.actualStart !== undefined) {
        slot = { start: p.actualStart, end: p.actualEnd <= now ? p.actualEnd : Math.max(p.actualStart + (p.end - p.start), now + g) };
      }
      for (const r of p.resourceIds) push(resourceBusy, r, slot);
      push(visitBusy, p.visitId, slot);
      fixedStepEnds.set(p.stepId, slot.end);
    }
    return { horizonEnd, granularityMs: g, resources: scenario.resources, resourceBusy, visitBusy, fixedStepEnds };
  };

  const commit = (v, steps, plan) => {
    for (const p of plan.placements) placements.push({ ...p, code: steps.find((s) => s.stepId === p.stepId).code });
    for (const u of plan.unplaced) unplaced.push({ ...u, visitId: v.id });
  };

  // Appointments are booked ahead of the day, in order of their time.
  const appointments = scenario.visits.filter((v) => v.kind === 'appointment').sort((a, b) => a.scheduledAt - b.scheduledAt);
  let booked = { horizonEnd, granularityMs: g, resources: scenario.resources, resourceBusy: new Map(), visitBusy: new Map(), fixedStepEnds: new Map() };
  for (const v of appointments) {
    const steps = plannerSteps(v, v.scheduledAt);
    const plan = planSteps(steps, booked);
    commit(v, steps, plan);
    booked = plan.state;
  }

  // Through the day: walk-ins are planned on arrival around what is actually
  // happening, and whenever resources free up staff start the earliest-booked
  // step whose patient is present and ready (late patients don't hold the line).
  const walkIns = scenario.visits.filter((x) => x.kind === 'walk_in').sort((a, b) => a.arrival - b.arrival);
  let nextWalkIn = 0;
  let t = Math.min(...scenario.visits.map((v) => v.arrival));
  /** Who goes first among ready patients: plan order, or when each patient was due (booked time / walk-in arrival). */
  const dispatchKey = (p) => {
    if (scenario.dispatch !== 'due') return p.start;
    const v = visitsById.get(p.visitId);
    return v.kind === 'appointment' ? v.scheduledAt : v.arrival;
  };
  const isFree = (now) => (r) => (resourceFree.get(r) ?? 0) <= now;
  /** Booked resources if free, otherwise any interchangeable free ones (late binding). */
  const bindResources = (p, now) => {
    if (p.resourceIds.every(isFree(now))) return p.resourceIds;
    if (!scenario.lateBinding) return null;
    return matchResources(scenario.services.get(p.code).requirements, scenario.resources, isFree(now), p.resourceIds);
  };
  const ready = (p, now) =>
    p.actualStart === undefined &&
    visitsById.get(p.visitId).arrival <= now &&
    (visitFree.get(p.visitId) ?? 0) <= now &&
    prereqReady(scenario, p.code, visitEnds.get(p.visitId), visitsById.get(p.visitId).codes) <= now &&
    bindResources(p, now) !== null;

  for (let guard = 0; guard < 100_000; guard++) {
    while (nextWalkIn < walkIns.length && walkIns[nextWalkIn].arrival <= t) {
      const v = walkIns[nextWalkIn++];
      const steps = plannerSteps(v, v.arrival);
      commit(v, steps, planSteps(steps, stateAt(t)));
    }
    const candidates = placements.filter((p) => ready(p, t)).sort((a, b) => dispatchKey(a) - dispatchKey(b) || a.stepId.localeCompare(b.stepId));
    for (const p of candidates) {
      if (!ready(p, t)) continue;
      p.resourceIds = bindResources(p, t);
      p.actualStart = t;
      p.actualEnd = t + durations(p.visitId, p.code) * MIN;
      for (const r of p.resourceIds) resourceFree.set(r, p.actualEnd);
      visitFree.set(p.visitId, p.actualEnd);
      visitEnds.get(p.visitId).set(p.code, p.actualEnd);
    }

    const pending = placements.filter((p) => p.actualStart === undefined);
    if (pending.length === 0 && nextWalkIn >= walkIns.length) break;
    const future = [
      ...(nextWalkIn < walkIns.length ? [walkIns[nextWalkIn].arrival] : []),
      ...pending.map((p) => visitsById.get(p.visitId).arrival),
      ...pending.map((p) => prereqReady(scenario, p.code, visitEnds.get(p.visitId), visitsById.get(p.visitId).codes)),
      ...resourceFree.values(),
      ...visitFree.values(),
    ].filter((x) => x > t && Number.isFinite(x));
    if (future.length === 0) break;
    t = Math.min(...future);
  }

  return scenario.visits.map((v) => ({
    id: v.id,
    kind: v.kind,
    arrival: v.arrival,
    steps: placements
      .filter((p) => p.visitId === v.id && p.actualStart !== undefined)
      .map((p) => ({ code: p.code, plannedStart: p.start, start: p.actualStart, end: p.actualEnd }))
      .sort((a, b) => a.start - b.start),
    unserved: unplaced.filter((u) => u.visitId === v.id).length,
  }));
}

/** Clinically required gaps (e.g. post-prandial after fasting sugar) are not waiting the centre caused. */
function requiredGapMin(scenario, codes) {
  return codes.reduce((sum, code) => sum + (scenario.prereqs.get(code) ?? []).filter((p) => codes.includes(p.requires)).reduce((s, p) => s + p.minGapMin, 0), 0);
}

/**
 * Waiting = time in the centre not being served (arrival to last test end,
 * minus service time and any clinically required gaps).
 */
export function summarise(results, scenario) {
  const served = results.filter((r) => r.steps.length > 0);
  const sorted = (xs) => [...xs].sort((a, b) => a - b);
  const round = (x) => (x == null ? null : Math.round(x * 10) / 10);
  const waitOf = (r) => {
    const idle = (r.steps.at(-1).end - r.arrival - r.steps.reduce((s, x) => s + (x.end - x.start), 0)) / MIN;
    return Math.max(0, idle - requiredGapMin(scenario, r.steps.map((s) => s.code)));
  };
  const waits = sorted(served.map(waitOf));
  const kindWaits = (kind) => sorted(served.filter((r) => r.kind === kind).map(waitOf));
  const firstWaits = sorted(served.map((r) => Math.max(0, r.steps[0].start - r.arrival) / MIN));
  const inCentre = sorted(served.map((r) => (r.steps.at(-1).end - r.arrival) / MIN));
  const lastEnd = Math.max(...served.map((r) => r.steps.at(-1).end));
  return {
    visits: results.length,
    unserved: results.reduce((s, r) => s + r.unserved, 0),
    waitP50: round(percentile(waits, 50)),
    waitP90: round(percentile(waits, 90)),
    appointmentWaitP50: round(percentile(kindWaits('appointment'), 50)),
    appointmentWaitP90: round(percentile(kindWaits('appointment'), 90)),
    walkInWaitP50: round(percentile(kindWaits('walk_in'), 50)),
    walkInWaitP90: round(percentile(kindWaits('walk_in'), 90)),
    firstWaitP50: round(percentile(firstWaits, 50)),
    firstWaitP90: round(percentile(firstWaits, 90)),
    inCentreP50: round(percentile(inCentre, 50)),
    inCentreP90: round(percentile(inCentre, 90)),
    waitOver30: served.length ? round((100 * waits.filter((w) => w > 30).length) / served.length) : null,
    overtimeMin: round(Math.max(0, lastEnd - scenario.close) / MIN),
  };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Realised durations: configured × a skewed factor (most run close to plan, some overrun badly). */
export function sampledDurations(scenario, seed) {
  const rand = mulberry32(seed);
  const cache = new Map();
  return (visitId, code) => {
    const key = `${visitId}:${code}`;
    if (!cache.has(key)) {
      const u = rand();
      const factor = u < 0.85 ? 0.8 + 0.5 * rand() : 1.3 + 0.7 * rand();
      cache.set(key, Math.max(1, Math.round(scenario.services.get(code).durationMin * factor)));
    }
    return cache.get(key);
  };
}

const METRICS = [
  'waitP50',
  'waitP90',
  'appointmentWaitP50',
  'appointmentWaitP90',
  'walkInWaitP50',
  'walkInWaitP90',
  'firstWaitP50',
  'inCentreP50',
  'inCentreP90',
  'waitOver30',
  'overtimeMin',
  'unserved',
];

/** Runs both policies over several duration draws and averages the summaries. */
export function compareStrategies(scenario, { replications = 10, seed = 1 } = {}) {
  const runs = [];
  for (let i = 0; i < replications; i++) {
    const durations = sampledDurations(scenario, seed + i);
    runs.push({
      baseline: summarise(simulateDepartmentQueues(scenario, durations), scenario),
      turnwise: summarise(simulateTurnwise(scenario, durations), scenario),
    });
  }
  const mean = (key, policy) => {
    const xs = runs.map((r) => r[policy][key]).filter((x) => x != null);
    return xs.length ? Math.round((10 * xs.reduce((s, x) => s + x, 0)) / xs.length) / 10 : null;
  };
  const metrics = Object.fromEntries(METRICS.map((k) => [k, { baseline: mean(k, 'baseline'), turnwise: mean(k, 'turnwise') }]));
  const turnwiseWins = runs.filter((r) => r.turnwise.waitP50 <= r.baseline.waitP50).length;
  return { visits: scenario.visits.length, replications, metrics, turnwiseWins };
}
