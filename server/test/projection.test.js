import { describe, expect, it } from 'vitest';
import { expectedDuration, projectSchedule, waitRange } from '../src/domain/projection.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 1, 4, 0);

const s = (stepId, visitId, plannedStartMin, durMin, extra = {}) => ({
  stepId,
  visitId,
  status: 'scheduled',
  plannedStart: T0 + plannedStartMin * MIN,
  plannedEnd: T0 + (plannedStartMin + durMin) * MIN,
  expectedMin: durMin,
  resourceIds: ['usg1'],
  ...extra,
});

describe('projectSchedule', () => {
  it('propagates an overrun to every later booking on the same resource', () => {
    const steps = [
      s('a', 'v1', 0, 15, { status: 'in_service', actualStart: T0 }),
      s('b', 'v2', 15, 15),
      s('c', 'v3', 30, 15),
    ];
    // 30 minutes in, the first scan is still going.
    const p = projectSchedule(steps, T0 + 30 * MIN);
    expect(p.get('b').start).toBe(T0 + 31 * MIN);
    expect(p.get('b').delayMin).toBe(16);
    expect(p.get('c').start).toBe(T0 + 46 * MIN);
  });

  it('does not delay bookings on unrelated resources', () => {
    const steps = [s('a', 'v1', 0, 15, { status: 'in_service', actualStart: T0 }), s('x', 'v9', 15, 10, { resourceIds: ['bay1'] })];
    const p = projectSchedule(steps, T0 + 30 * MIN);
    expect(p.get('x').delayMin).toBe(15); // only because "now" has passed its slot
    expect(p.get('x').start).toBe(T0 + 30 * MIN);
  });

  it('keeps a patient from starting a second step before the first ends', () => {
    const steps = [s('a', 'v1', 0, 20, { resourceIds: ['r1'] }), s('b', 'v1', 10, 10, { resourceIds: ['r2'] })];
    const p = projectSchedule(steps, T0);
    expect(p.get('b').start).toBe(T0 + 20 * MIN);
  });
});

describe('expectedDuration', () => {
  it('leans on configuration with few samples and on history with many', () => {
    expect(expectedDuration(20, 30, 0)).toBe(20);
    expect(expectedDuration(20, 30, 1)).toBeCloseTo(21.67, 1);
    expect(expectedDuration(20, 30, 95)).toBeCloseTo(29.5, 1);
  });
});

describe('waitRange', () => {
  it('widens with observed estimate error and stays in 5-minute steps', () => {
    expect(waitRange(20, 4)).toEqual({ low: 15, high: 25 });
    expect(waitRange(20, 20)).toEqual({ low: 10, high: 40 });
    expect(waitRange(0, null)).toEqual({ low: 0, high: 5 });
  });
});
