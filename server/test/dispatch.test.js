import { describe, expect, it } from 'vitest';
import { suggestNextUp } from '../src/domain/dispatch.js';

const MIN = 60_000;
const now = Date.UTC(2026, 0, 5, 5, 0);
const resources = [
  { id: 'bay1', name: 'Bay 1', capabilities: ['bay'], active: true },
  { id: 'bay2', name: 'Bay 2', capabilities: ['bay'], active: true },
  { id: 'usg', name: 'USG', capabilities: ['ultrasound'], active: true },
];

const candidate = (stepId, visitId, dueAt, { requirements = ['bay'], reserved = ['bay1'], kind = 'walk_in', durationMin = 10 } = {}) => ({
  stepId,
  visitId,
  patient: visitId,
  service: requirements[0],
  requirements,
  durationMs: durationMin * MIN,
  reservedResourceIds: reserved,
  dueAt,
  kind,
});

describe('next up', () => {
  it('calls whoever was due first, not whoever is booked first', () => {
    const walkIn = candidate('s1', 'walk-in', now - 20 * MIN, { reserved: ['bay1'] });
    const earlyAppointment = candidate('s2', 'early-appt', now + 25 * MIN, { reserved: ['bay1'], kind: 'appointment' });
    const [first] = suggestNextUp({ now, resources: resources.slice(0, 1), busy: new Map(), candidates: [earlyAppointment, walkIn] });
    expect(first.visitId).toBe('walk-in');
    expect(first.waitingMin).toBe(20);
  });

  it('never suggests two people for the same resource or one person twice', () => {
    const out = suggestNextUp({
      now,
      resources,
      busy: new Map(),
      candidates: [
        candidate('a1', 'a', now - 30 * MIN),
        candidate('a2', 'a', now - 30 * MIN, { requirements: ['ultrasound'], reserved: ['usg'] }),
        candidate('b1', 'b', now - 20 * MIN),
        candidate('c1', 'c', now - 10 * MIN),
      ],
    });
    expect(out.map((s) => s.visitId)).toEqual(['a', 'b']);
    expect(new Set(out.flatMap((s) => s.resourceIds)).size).toBe(2);
  });

  it('swaps to an identical free resource when the booked one is busy', () => {
    const busy = new Map([['bay1', [{ start: now - 5 * MIN, end: now + 5 * MIN, stepId: 'someone-else' }]]]);
    const [s] = suggestNextUp({ now, resources, busy, candidates: [candidate('s1', 'v', now - 5 * MIN)] });
    expect(s.resourceIds).toEqual(['bay2']);
    expect(s.swapped).toBe(true);
  });

  it('may push a later booking on the booked resource, and says so', () => {
    const busy = new Map([
      ['bay1', [{ start: now + 5 * MIN, end: now + 15 * MIN, stepId: 'booked-later' }]],
      ['bay2', [{ start: now - 1 * MIN, end: now + 20 * MIN, stepId: 'in-progress', hard: true }]],
    ]);
    const late = { ...candidate('s1', 'v', now - 15 * MIN), plannedStart: now - 10 * MIN };
    const [s] = suggestNextUp({ now, resources, busy, candidates: [late] });
    expect(s.resourceIds).toEqual(['bay1']);
    expect(s.bumps).toBe(1);
    expect(s.bookedTimeReached).toBe(true);
  });

  it('prefers a free identical resource over pushing anyone', () => {
    const busy = new Map([['bay1', [{ start: now + 5 * MIN, end: now + 15 * MIN, stepId: 'booked-later' }]]]);
    const late = { ...candidate('s1', 'v', now - 15 * MIN), plannedStart: now - 10 * MIN };
    const [s] = suggestNextUp({ now, resources, busy, candidates: [late] });
    expect(s).toMatchObject({ resourceIds: ['bay2'], swapped: true, bumps: 0 });
  });

  it('never takes a resource that is in use, down, or booked for someone due earlier', () => {
    const early = { ...candidate('s1', 'v', now - 5 * MIN), plannedStart: now + 20 * MIN };
    const blocked = (entry) => suggestNextUp({ now, resources: resources.slice(0, 1), busy: new Map([['bay1', [entry]]]), candidates: [early] });
    expect(blocked({ start: now - 5 * MIN, end: now + 5 * MIN, stepId: 'running', hard: true })).toEqual([]);
    expect(blocked({ start: now, end: now + 30 * MIN, stepId: null, hard: true })).toEqual([]);
    expect(blocked({ start: now + 5 * MIN, end: now + 15 * MIN, stepId: 'booked-before-me' })).toEqual([]);
  });

  it('does not push bookings on a swapped-in resource, because Start would not', () => {
    const busy = new Map([
      ['bay1', [{ start: now - 5 * MIN, end: now + 5 * MIN, stepId: 'running', hard: true }]],
      ['bay2', [{ start: now + 5 * MIN, end: now + 15 * MIN, stepId: 'booked-later' }]],
    ]);
    const late = { ...candidate('s1', 'v', now - 15 * MIN), plannedStart: now - 10 * MIN };
    expect(suggestNextUp({ now, resources, busy, candidates: [late] })).toEqual([]);
  });

  it("prefers the patient's earliest-planned step and counts their own next test if it has to move", () => {
    const later = { ...candidate('later', 'v', now - 5 * MIN, { requirements: ['ultrasound'], reserved: ['usg'] }), plannedStart: now + 40 * MIN };
    const sooner = { ...candidate('sooner', 'v', now - 5 * MIN), plannedStart: now + 15 * MIN };
    expect(suggestNextUp({ now, resources, busy: new Map(), candidates: [later, sooner] })[0].stepId).toBe('sooner');

    const squeezed = { ...later, ownBusy: [{ start: now + 5 * MIN, end: now + 20 * MIN, stepId: 'next-test' }] };
    expect(suggestNextUp({ now, resources, busy: new Map(), candidates: [squeezed] })[0].bumps).toBe(1);
  });

  it('ignores its own booking when checking whether the resource is free', () => {
    const busy = new Map([['bay1', [{ start: now + 2 * MIN, end: now + 12 * MIN, stepId: 's1' }]]]);
    const [s] = suggestNextUp({ now, resources: resources.slice(0, 1), busy, candidates: [candidate('s1', 'v', now - 5 * MIN)] });
    expect(s.resourceIds).toEqual(['bay1']);
    expect(s.swapped).toBe(false);
  });
});
