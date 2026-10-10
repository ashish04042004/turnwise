/**
 * Runs against the real Postgres from docker-compose, in an isolated test
 * centre that is deleted afterwards (the demo centre is untouched).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { pool } from '../src/db.js';
import { enqueueOutbox } from '../src/events.js';
import { migrate } from '../src/migrate.js';
import { confirmHold, createHold, createWalkIn } from '../src/services/booking.js';
import { getCentre } from '../src/services/context.js';
import { completeStep, startStep, sweepOverruns } from '../src/services/operations.js';
import { applyProposal, generateProposal, markResourceDown } from '../src/services/replan.js';

const MIN = 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let centre;
const res = {};
const svc = {};

async function futureSlot(minutesAhead) {
  const now = (await pool.query('SELECT now() AS now')).rows[0].now.getTime();
  return new Date(Math.ceil((now + minutesAhead * MIN) / (5 * MIN)) * 5 * MIN);
}

async function overlappingActiveReservations() {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM reservations a JOIN reservations b
       ON a.resource_id = b.resource_id AND a.id < b.id AND a.during && b.during
     WHERE a.centre_id = $1 AND a.status IN ('held', 'confirmed', 'in_use') AND b.status IN ('held', 'confirmed', 'in_use')`,
    [centre.id],
  );
  return rows[0].n;
}

/** A fixed-offset zone where it is currently mid-morning, so slots never run past closing. */
function midMorningZone() {
  let offset = 10 - new Date().getUTCHours();
  if (offset < -12) offset += 24;
  if (offset > 14) offset -= 24;
  return offset >= 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}

beforeAll(async () => {
  await migrate();
  const { rows } = await pool.query(
    `INSERT INTO centres (name, city, timezone, opens_at, closes_at, hold_ttl_seconds)
     VALUES ('Integration Test Centre', 'Test', $1, '07:00', '23:00', 1) RETURNING id`,
    [midMorningZone()],
  );
  centre = await getCentre(pool, rows[0].id);
  for (const [key, name, caps] of [
    ['solo', 'Solo Analyser', ['solo']],
    ['queue', 'Queue Analyser', ['queue']],
    ['usgA', 'USG A', ['ultrasound']],
    ['usgB', 'USG B', ['ultrasound']],
    ['drX', 'Dr X', ['radiologist']],
  ]) {
    res[key] = (await pool.query(`INSERT INTO resources (centre_id, name, kind, capabilities) VALUES ($1, $2, 'equipment', $3) RETURNING id`, [centre.id, name, caps])).rows[0].id;
  }
  for (const [key, duration, reqs] of [
    ['SOLO', 10, ['solo']],
    ['QUEUE', 10, ['queue']],
    ['USG', 20, ['ultrasound', 'radiologist']],
  ]) {
    svc[key] = (
      await pool.query(`INSERT INTO services (centre_id, code, name, category, duration_min, requirements) VALUES ($1, $2, $2, 'test', $3, $4) RETURNING id`, [
        centre.id,
        key,
        duration,
        reqs,
      ])
    ).rows[0].id;
  }
});

afterAll(async () => {
  if (centre) {
    await pool.query('DELETE FROM visits WHERE centre_id = $1', [centre.id]);
    await pool.query('DELETE FROM reservations WHERE centre_id = $1', [centre.id]);
    await pool.query('DELETE FROM centres WHERE id = $1', [centre.id]);
  }
  await pool.end();
});

describe('correctness under concurrency', () => {
  it('lets exactly one of 30 simultaneous holds claim the same slot', async () => {
    const start = await futureSlot(30);
    const results = await Promise.allSettled(
      Array.from({ length: 30 }, (_, i) => createHold(centre, { patient: { name: `Racer ${i}` }, serviceIds: [svc.SOLO], start }, 'test')),
    );
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost.every((r) => r.reason.status === 409)).toBe(true);
    expect(await overlappingActiveReservations()).toBe(0);
  });

  it('rejects overlapping claims in the database even when the planner is bypassed', async () => {
    const start = await futureSlot(90);
    const end = new Date(start.getTime() + 10 * MIN);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        pool.query(
          `INSERT INTO reservations (centre_id, resource_id, kind, status, during) VALUES ($1, $2, 'downtime', 'confirmed', tstzrange($3, $4, '[)'))`,
          [centre.id, res.solo, start, end],
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected').every((r) => r.reason.code === '23P01')).toBe(true);
  });

  it('places 12 simultaneous walk-ins on one machine without any overlap', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) => createWalkIn(centre, { patient: { name: `Walk In ${i}` }, serviceIds: [svc.QUEUE] }, 'test')),
    );
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    const starts = results.map((r) => r.value.steps[0].start);
    expect(new Set(starts).size).toBe(12);
    expect(await overlappingActiveReservations()).toBe(0);
  });
});

describe('temporary holds', () => {
  it('releases expired holds inline so capacity is reusable without the worker', async () => {
    const start = await futureSlot(60);
    const first = await createHold(centre, { patient: { name: 'Slow Confirmer' }, serviceIds: [svc.SOLO], start }, 'test');
    await sleep(1300);
    const second = await createHold(centre, { patient: { name: 'Next Patient' }, serviceIds: [svc.SOLO], start }, 'test');
    expect(second.visitId).not.toBe(first.visitId);
    const { rows } = await pool.query('SELECT status FROM visits WHERE id = $1', [first.visitId]);
    expect(rows[0].status).toBe('expired');
    await expect(confirmHold(centre, first.visitId, 'test')).rejects.toMatchObject({ status: 410 });
  });
});

describe('disruption recovery', () => {
  let walkIn;

  it('moves an affected scan to a compatible machine when one goes down', async () => {
    walkIn = await createWalkIn(centre, { patient: { name: 'Scan Patient' }, serviceIds: [svc.USG] }, 'test');
    expect(walkIn.steps[0].resources).toContain('USG A');
    const down = await markResourceDown(centre, res.usgA, 30, 'test outage', 'test');
    expect(down.displaced.map((d) => d.visitId)).toEqual([walkIn.visitId]);

    const { rows } = await pool.query('SELECT options FROM replan_proposals WHERE id = $1', [down.proposalId]);
    const best = rows[0].options.find((o) => o.recommended);
    expect(best.unschedulable).toEqual([]);
    expect(best.moves[0].to.resources).toContain('USG B');

    await applyProposal(centre, down.proposalId, best.key, 'test');
    const { rows: step } = await pool.query(`SELECT status FROM visit_steps WHERE visit_id = $1`, [walkIn.visitId]);
    expect(step[0].status).toBe('scheduled');
    expect(await overlappingActiveReservations()).toBe(0);
  });

  it('refuses to apply a proposal after the centre changed underneath it', async () => {
    const down = await markResourceDown(centre, res.usgB, 30, 'second outage', 'test');
    const { rows } = await pool.query('SELECT options FROM replan_proposals WHERE id = $1', [down.proposalId]);
    const option = rows[0].options[0];
    await pool.query('UPDATE visit_steps SET version = version + 1 WHERE id = $1', [option.moves[0].stepId]);
    await expect(applyProposal(centre, down.proposalId, option.key, 'test')).rejects.toMatchObject({ status: 409 });
    const { rows: p } = await pool.query('SELECT status FROM replan_proposals WHERE id = $1', [down.proposalId]);
    expect(p[0].status).toBe('stale');
  });

  it('reports explicitly when no feasible schedule exists', async () => {
    await pool.query('UPDATE resources SET active = false WHERE id = $1', [res.drX]);
    const proposal = await generateProposal(centre, 'radiologist unavailable', 'test');
    const option = proposal.options[0];
    expect(option.moves).toEqual([]);
    expect(option.unschedulable[0].reason).toMatch(/radiologist/);
    await pool.query('UPDATE resources SET active = true WHERE id = $1', [res.drX]);
  });

  it('keeps the cause of a superseded proposal in its replacement', async () => {
    const next = await generateProposal(centre, 'radiologist back on shift', 'test');
    expect(next.trigger).toContain('radiologist unavailable');
    expect(next.trigger).toContain('radiologist back on shift');
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM replan_proposals WHERE centre_id = $1 AND status = 'pending'`, [centre.id]);
    expect(rows[0].n).toBe(1);
  });
});

describe('late resource binding', () => {
  it('swaps a blocked bay for an identical free one when staff start the service', async () => {
    const bays = [];
    for (const name of ['Bay One', 'Bay Two']) {
      bays.push((await pool.query(`INSERT INTO resources (centre_id, name, kind, capabilities) VALUES ($1, $2, 'room', '{bay}') RETURNING id`, [centre.id, name])).rows[0].id);
    }
    const bayService = (
      await pool.query(`INSERT INTO services (centre_id, code, name, category, duration_min, requirements) VALUES ($1, 'BAY', 'Bay test', 'test', 10, '{bay}') RETURNING id`, [centre.id])
    ).rows[0].id;
    const walkIn = (name) => createWalkIn(centre, { patient: { name }, serviceIds: [bayService] }, 'test');
    const first = await walkIn('Bay First');
    const second = await walkIn('Bay Second');
    const third = await walkIn('Bay Third');
    const thirdBay = third.steps[0].resources[0];
    const [holder, other] = first.steps[0].resources[0] === thirdBay ? [first, second] : [second, first];

    await startStep(centre, holder.steps[0].stepId, { force: true }, 'test');
    await startStep(centre, other.steps[0].stepId, { force: true }, 'test');
    await completeStep(centre, other.steps[0].stepId, 'test');

    const started = await startStep(centre, third.steps[0].stepId, {}, 'test');
    expect(started.swapped).toMatchObject({ from: [thirdBay], to: [other.steps[0].resources[0]] });
    expect(started.displaced).toEqual([]);
    expect(await overlappingActiveReservations()).toBe(0);

    for (const v of [holder, third]) await completeStep(centre, v.steps[0].stepId, 'test');
  });
});

describe('overrun sweeper', () => {
  async function runningStepEndingAgo(minutesAgo) {
    const walkIn = await createWalkIn(centre, { patient: { name: `Overrun ${minutesAgo}` }, serviceIds: [svc.SOLO] }, 'test');
    const stepId = walkIn.steps[0].stepId;
    await startStep(centre, stepId, { force: true }, 'test');
    const range = `tstzrange(now() - interval '30 minutes', now() - make_interval(mins => ${minutesAgo}), '[)')`;
    await pool.query(`UPDATE reservations SET during = ${range} WHERE step_id = $1 AND status = 'in_use'`, [stepId]);
    await pool.query(`UPDATE visit_steps SET planned = ${range}, actual_start = now() - interval '30 minutes' WHERE id = $1`, [stepId]);
    return stepId;
  }

  const plannedEnd = async (stepId) => (await pool.query('SELECT upper(planned) AS e, now() AS now FROM visit_steps WHERE id = $1', [stepId])).rows[0];

  it('leaves short overruns to the projection and extends long ones', async () => {
    const shortRun = await runningStepEndingAgo(2);
    expect(await sweepOverruns(centre.id)).toBe(0);
    const before = await plannedEnd(shortRun);
    expect(before.e < before.now).toBe(true);
    await completeStep(centre, shortRun, 'test');

    const longRun = await runningStepEndingAgo(config.overrunGraceMin + 1);
    expect(await sweepOverruns(centre.id)).toBe(1);
    const after = await plannedEnd(longRun);
    expect(after.e > after.now).toBe(true);
    await completeStep(centre, longRun, 'test');
  });
});

describe('transactional outbox', () => {
  it('records each logical side effect once, however many times it is enqueued', async () => {
    for (let i = 0; i < 3; i++) await enqueueOutbox(pool, centre.id, 'notify.patient', { message: 'hi' }, `test-dup-${centre.id}`);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM outbox WHERE idempotency_key = $1`, [`test-dup-${centre.id}`]);
    expect(rows[0].n).toBe(1);
  });
});
