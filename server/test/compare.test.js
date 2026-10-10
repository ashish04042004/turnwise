import { describe, expect, it } from 'vitest';
import { compareStrategies, sampledDurations, simulateDepartmentQueues, simulateTurnwise, summarise } from '../src/domain/compare.js';

const MIN = 60_000;
const open = Date.UTC(2026, 0, 5, 3, 0);

function scenario(visits) {
  return {
    open,
    close: open + 8 * 60 * MIN,
    granularityMs: 5 * MIN,
    resources: [
      { id: 'bay', name: 'Bay', capabilities: ['collection'], active: true },
      { id: 'usg', name: 'USG', capabilities: ['ultrasound'], active: true },
      { id: 'dr', name: 'Dr', capabilities: ['radiologist'], active: true },
    ],
    services: new Map([
      ['FBS', { durationMin: 10, requirements: ['collection'], order: 0 }],
      ['PPBS', { durationMin: 10, requirements: ['collection'], order: 1 }],
      ['USG', { durationMin: 20, requirements: ['ultrasound', 'radiologist'], order: 2 }],
    ]),
    prereqs: new Map([['PPBS', [{ requires: 'FBS', minGapMin: 120 }]]]),
    visits,
  };
}

const configured = (s) => (_visitId, code) => s.services.get(code).durationMin;

function assertNoResourceOverlap(results, s) {
  const usage = new Map();
  for (const r of results) {
    for (const step of r.steps) {
      for (const cap of s.services.get(step.code).requirements) {
        const list = usage.get(cap) ?? [];
        expect(list.some((u) => u.start < step.end && step.start < u.end)).toBe(false);
        list.push(step);
        usage.set(cap, list);
      }
    }
  }
}

describe('department queues baseline', () => {
  it('blocks the whole queue behind its head even when other resources sit idle', () => {
    const s = scenario([
      { id: 'a', kind: 'walk_in', arrival: open, codes: ['FBS', 'USG'] },
      { id: 'b', kind: 'walk_in', arrival: open, codes: ['FBS', 'USG'] },
      { id: 'c', kind: 'walk_in', arrival: open, codes: ['FBS', 'USG'] },
    ]);
    const results = simulateDepartmentQueues(s, configured(s));
    // Everyone must start with the blood test, so the scanner is idle for the first 10 minutes.
    expect(Math.min(...results.flatMap((r) => r.steps.filter((x) => x.code === 'USG').map((x) => x.start)))).toBe(open + 10 * MIN);
    expect(results.every((r) => r.unserved === 0)).toBe(true);
    assertNoResourceOverlap(results, s);
  });

  it('respects the minimum gap between linked tests', () => {
    const s = scenario([{ id: 'a', kind: 'walk_in', arrival: open, codes: ['PPBS', 'FBS'] }]);
    const [r] = simulateDepartmentQueues(s, configured(s));
    const fbs = r.steps.find((x) => x.code === 'FBS');
    const ppbs = r.steps.find((x) => x.code === 'PPBS');
    expect(ppbs.start - fbs.end).toBeGreaterThanOrEqual(120 * MIN);
  });
});

describe('turnwise policy', () => {
  it('sends a patient to an idle scanner instead of a long blood-collection queue', () => {
    const s = scenario([
      ...Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, kind: 'walk_in', arrival: open, codes: ['FBS'] })),
      { id: 'z', kind: 'walk_in', arrival: open + MIN, codes: ['FBS', 'USG'] },
    ]);
    const waitOf = (results) => {
      const r = results.find((x) => x.id === 'z');
      return (r.steps.at(-1).end - r.arrival - 30 * MIN) / MIN;
    };
    const base = simulateDepartmentQueues(s, configured(s));
    const tw = simulateTurnwise(s, configured(s));
    expect(waitOf(base)).toBe(49);
    expect(tw.find((x) => x.id === 'z').steps[0].code).toBe('USG');
    expect(waitOf(tw)).toBeLessThan(waitOf(base));
    expect(tw.every((r) => r.unserved === 0)).toBe(true);
  });

  it('never double-books a resource or the patient, even with overruns and late arrivals', () => {
    const visits = [
      { id: 'appt1', kind: 'appointment', scheduledAt: open, arrival: open + 15 * MIN, codes: ['USG'] },
      { id: 'appt2', kind: 'appointment', scheduledAt: open + 20 * MIN, arrival: open + 20 * MIN, codes: ['USG', 'FBS'] },
      ...Array.from({ length: 6 }, (_, i) => ({ id: `w${i}`, kind: 'walk_in', arrival: open + i * 7 * MIN, codes: ['FBS', 'USG'] })),
    ];
    const s = scenario(visits);
    const results = simulateTurnwise(s, () => 25);
    assertNoResourceOverlap(results, s);
    for (const r of results) {
      expect(r.steps[0].start).toBeGreaterThanOrEqual(r.arrival);
      for (let i = 1; i < r.steps.length; i++) expect(r.steps[i].start).toBeGreaterThanOrEqual(r.steps[i - 1].end);
    }
  });
});

describe('comparison', () => {
  it('does not count a clinically required gap as waiting', () => {
    const s = scenario([{ id: 'a', kind: 'walk_in', arrival: open, codes: ['FBS', 'PPBS'] }]);
    for (const sim of [simulateDepartmentQueues, simulateTurnwise]) {
      const summary = summarise(sim(s, configured(s)), s);
      expect(summary.waitP50).toBe(0);
      expect(summary.inCentreP50).toBe(140);
    }
  });

  it('is reproducible for a given seed', () => {
    const s = scenario(Array.from({ length: 10 }, (_, i) => ({ id: `v${i}`, kind: 'walk_in', arrival: open + i * 4 * MIN, codes: ['FBS', 'USG'] })));
    expect(compareStrategies(s, { replications: 3, seed: 7 })).toEqual(compareStrategies(s, { replications: 3, seed: 7 }));
    const d = sampledDurations(s, 1);
    expect(d('v1', 'USG')).toBe(d('v1', 'USG'));
  });
});
