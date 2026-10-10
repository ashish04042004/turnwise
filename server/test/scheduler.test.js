import { describe, expect, it } from 'vitest';
import { findEarliestSlot, planSteps } from '../src/domain/scheduler.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 1, 3, 30); // 09:00 IST

const resources = [
  { id: 'usg1', name: 'USG 1', capabilities: ['ultrasound'], active: true },
  { id: 'usg2', name: 'USG 2', capabilities: ['ultrasound'], active: true },
  { id: 'dr1', name: 'Dr A', capabilities: ['radiologist'], active: true },
  { id: 'bay', name: 'Bay', capabilities: ['blood_collection'], active: true },
  { id: 'phl', name: 'Phleb', capabilities: ['phlebotomist'], active: true },
];

function state(overrides = {}) {
  return {
    horizonEnd: T0 + 8 * 60 * MIN,
    granularityMs: 5 * MIN,
    resources,
    resourceBusy: new Map(),
    visitBusy: new Map(),
    fixedStepEnds: new Map(),
    ...overrides,
  };
}

const step = (id, visitId, requirements, durationMin, extra = {}) => ({
  stepId: id,
  visitId,
  label: id,
  durationMin,
  requirements,
  earliest: T0,
  priority: 0,
  orderKey: T0,
  prereqs: [],
  ...extra,
});

describe('findEarliestSlot', () => {
  it('needs every required resource free for the whole duration', () => {
    const s = state({ resourceBusy: new Map([['dr1', [{ start: T0, end: T0 + 25 * MIN }]]]) });
    const slot = findEarliestSlot(step('a', 'v1', ['ultrasound', 'radiologist'], 20), s, T0);
    expect(slot.start).toBe(T0 + 25 * MIN);
    expect(slot.resourceIds).toContain('dr1');
  });

  it('uses an alternative compatible resource instead of waiting', () => {
    const s = state({ resourceBusy: new Map([['usg1', [{ start: T0, end: T0 + 60 * MIN }]]]) });
    const slot = findEarliestSlot(step('a', 'v1', ['ultrasound', 'radiologist'], 20), s, T0);
    expect(slot.start).toBe(T0);
    expect(slot.resourceIds).toEqual(['usg2', 'dr1']);
  });

  it('never puts the same patient in two places at once', () => {
    const s = state({ visitBusy: new Map([['v1', [{ start: T0, end: T0 + 10 * MIN }]]]) });
    const slot = findEarliestSlot(step('a', 'v1', ['blood_collection', 'phlebotomist'], 10), s, T0);
    expect(slot.start).toBe(T0 + 10 * MIN);
  });

  it('rounds starts up to the planning granularity', () => {
    const slot = findEarliestSlot(step('a', 'v1', ['blood_collection', 'phlebotomist'], 10), state(), T0 + 2 * MIN);
    expect(slot.start).toBe(T0 + 5 * MIN);
  });

  it('returns null rather than pretending capacity exists after closing', () => {
    const s = state({ horizonEnd: T0 + 15 * MIN });
    expect(findEarliestSlot(step('a', 'v1', ['ultrasound', 'radiologist'], 20), s, T0)).toBeNull();
  });
});

describe('planSteps', () => {
  it('assigns distinct resources and never double-books across steps', () => {
    const steps = ['a', 'b', 'c'].map((id, i) => step(id, `v${i}`, ['ultrasound', 'radiologist'], 20));
    const { placements, unplaced } = planSteps(steps, state());
    expect(unplaced).toEqual([]);
    // Only one radiologist: scans must run back to back.
    expect(placements.map((p) => p.start)).toEqual([T0, T0 + 20 * MIN, T0 + 40 * MIN]);
  });

  it('honours configured prerequisites with a minimum gap', () => {
    const fbs = step('fbs', 'v1', ['blood_collection', 'phlebotomist'], 5);
    const ppbs = step('ppbs', 'v1', ['blood_collection', 'phlebotomist'], 5, { prereqs: [{ stepId: 'fbs', minGapMin: 120 }] });
    const { placements } = planSteps([ppbs, fbs], state());
    const byId = Object.fromEntries(placements.map((p) => [p.stepId, p]));
    expect(byId.ppbs.start).toBeGreaterThanOrEqual(byId.fbs.end + 120 * MIN);
  });

  it('places higher-priority steps first', () => {
    const low = step('low', 'v1', ['ultrasound', 'radiologist'], 20);
    const high = step('high', 'v2', ['ultrasound', 'radiologist'], 20, { priority: 5, orderKey: T0 + 1 });
    const { placements } = planSteps([low, high], state());
    expect(placements.find((p) => p.stepId === 'high').start).toBe(T0);
  });

  it('explains why a step cannot be placed', () => {
    const s = state({ resources: resources.map((r) => (r.id === 'dr1' ? { ...r, active: false } : r)) });
    const { unplaced } = planSteps([step('a', 'v1', ['ultrasound', 'radiologist'], 20)], s);
    expect(unplaced[0].reason).toMatch(/radiologist/);
  });

  it('marks dependents unplaceable when a prerequisite fails', () => {
    const s = state({ horizonEnd: T0 + 60 * MIN });
    const fbs = step('fbs', 'v1', ['blood_collection', 'phlebotomist'], 5);
    const ppbs = step('ppbs', 'v1', ['blood_collection', 'phlebotomist'], 5, { prereqs: [{ stepId: 'fbs', minGapMin: 120 }] });
    const { placements, unplaced } = planSteps([fbs, ppbs], s);
    expect(placements.map((p) => p.stepId)).toEqual(['fbs']);
    expect(unplaced[0]).toMatchObject({ stepId: 'ppbs', reason: 'No feasible slot before closing time' });
  });

  it('does not mutate the state it was given', () => {
    const s = state();
    planSteps([step('a', 'v1', ['ultrasound', 'radiologist'], 20)], s);
    expect(s.resourceBusy.size).toBe(0);
  });
});
