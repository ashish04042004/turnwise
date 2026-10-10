/**
 * Catalogue editing over HTTP: managers add and change what a centre offers,
 * and edits that break upcoming bookings route them through re-planning.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { closeCache } from '../src/cache.js';
import { pool } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { covers } from '../src/services/catalogue.js';
import { provisionCentre } from '../src/services/provisioning.js';

let server;
let base;
let centreId;
const staff = {};
let manager;
let reception;

const call = (path, { cookie, body, method = body ? 'POST' : 'GET' } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
const json = async (res, status) => {
  const body = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(status);
  return body;
};
const signIn = async (role, pin) => (await call('/auth/login', { body: { staffId: staff[role], pin } })).headers.getSetCookie()[0].split(';')[0];
const catalogue = async () => json(await call('/catalogue', { cookie: manager }), 200);

beforeAll(async () => {
  await migrate();
  const provisioned = await provisionCentre(pool, {
    name: 'Catalogue Test Centre',
    city: 'Test',
    hours: { opens: '00:00', closes: '23:59' },
    displayOrder: 1001,
    demo: true,
    staff: [
      { name: 'Cat manager', role: 'manager', pin: '3333' },
      { name: 'Cat reception', role: 'reception', pin: '1111' },
    ],
  });
  centreId = provisioned.centre.id;
  for (const s of provisioned.staff) staff[s.role] = s.id;
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}/api`;
  manager = await signIn('manager', '3333');
  reception = await signIn('reception', '1111');
});

afterAll(async () => {
  server?.close();
  if (centreId) {
    await pool.query('DELETE FROM visits WHERE centre_id = $1', [centreId]);
    await pool.query('DELETE FROM reservations WHERE centre_id = $1', [centreId]);
    await pool.query('DELETE FROM centres WHERE id = $1', [centreId]);
  }
  await closeCache();
  await pool.end();
});

describe('catalogue editing', () => {
  it('is for people with the settings permission only', async () => {
    expect((await call('/catalogue', { cookie: reception })).status).toBe(403);
    expect((await call('/catalogue/capabilities', { cookie: reception, body: { code: 'x', name: 'X' } })).status).toBe(403);
    const c = await catalogue();
    expect(c.centre.name).toBe('Catalogue Test Centre');
    expect(c.centre.opensAt).toBe('00:00');
  });

  it('builds a working catalogue from scratch and validates references', async () => {
    await json(await call('/catalogue/capabilities', { cookie: manager, body: { code: 'xray', name: 'X-ray' } }), 201);
    await json(await call('/catalogue/capabilities', { cookie: manager, body: { code: 'scan', name: 'Scanner' } }), 201);
    await json(await call('/catalogue/capabilities', { cookie: manager, body: { code: 'xray', name: 'Again' } }), 409);
    await json(await call('/catalogue/capabilities', { cookie: manager, body: { code: '1bad', name: 'Bad' } }), 400);
    await json(await call('/catalogue/categories', { cookie: manager, body: { code: 'imaging', name: 'Imaging' } }), 201);

    await json(await call('/catalogue/resources', { cookie: manager, body: { name: 'Room 1', kind: 'room', capabilities: ['nope'] } }), 400);
    await json(await call('/catalogue/resources', { cookie: manager, body: { name: 'Room 1', kind: 'room', capabilities: ['xray', 'scan'] } }), 201);
    await json(await call('/catalogue/resources', { cookie: manager, body: { name: 'Room 1', kind: 'room', capabilities: ['xray'] } }), 409);

    await json(
      await call('/catalogue/services', { cookie: manager, body: { code: 'XR', name: 'Chest X-ray', category: 'missing', durationMin: 15, requirements: ['xray'] } }),
      400,
    );
    const xr = await json(
      await call('/catalogue/services', { cookie: manager, body: { code: 'XR', name: 'Chest X-ray', category: 'imaging', durationMin: 15, requirements: ['xray'] } }),
      201,
    );
    const sc = await json(
      await call('/catalogue/services', {
        cookie: manager,
        body: { code: 'SC', name: 'Scan', category: 'imaging', durationMin: 10, requirements: ['scan'], prerequisites: [{ requiresServiceId: xr.id, minGapMin: 0 }] },
      }),
      201,
    );
    // XR → SC → XR would be a loop.
    await json(await call(`/catalogue/services/${xr.id}`, { cookie: manager, method: 'PATCH', body: { prerequisites: [{ requiresServiceId: sc.id, minGapMin: 0 }] } }), 400);

    const c = await catalogue();
    expect(c.services.map((s) => s.code).sort()).toEqual(['SC', 'XR']);
    expect(c.services.find((s) => s.code === 'SC').prerequisites).toEqual([{ requiresServiceId: xr.id, minGapMin: 0 }]);
    expect(c.capabilities.find((x) => x.code === 'xray')).toMatchObject({ resources: 1, services: 1 });

    const board = await json(await call('/board', { cookie: manager }), 200);
    expect(board.services.map((s) => s.code)).toContain('XR');
  });

  it('refuses to delete categories and capabilities that are still in use', async () => {
    await json(await call('/catalogue/categories/imaging', { cookie: manager, method: 'DELETE' }), 409);
    await json(await call('/catalogue/capabilities/xray', { cookie: manager, method: 'DELETE' }), 409);
    await json(await call('/catalogue/capabilities', { cookie: manager, body: { code: 'spare', name: 'Spare' } }), 201);
    await json(await call('/catalogue/capabilities/spare', { cookie: manager, method: 'DELETE' }), 200);
  });

  it('displaces only the bookings a resource change actually breaks, then proposes a re-plan', async () => {
    const { services, resources } = await catalogue();
    const xr = services.find((s) => s.code === 'XR');
    const room = resources.find((r) => r.name === 'Room 1');
    const walkIn = await json(await call('/walk-ins', { cookie: manager, body: { patient: { name: 'Synthetic Patient' }, serviceIds: [xr.id] } }), 201);
    expect(walkIn.unplaced ?? []).toEqual([]);

    // The booking needs x-ray, so losing "scan" doesn't affect it.
    const keep = await json(await call(`/catalogue/resources/${room.id}`, { cookie: manager, method: 'PATCH', body: { capabilities: ['xray'] } }), 200);
    expect(keep.displaced).toBe(0);

    const lose = await json(await call(`/catalogue/resources/${room.id}`, { cookie: manager, method: 'PATCH', body: { capabilities: ['scan'] } }), 200);
    expect(lose.displaced).toBe(1);
    expect(lose.proposalId).toBeTruthy();
    const board = await json(await call('/board', { cookie: manager }), 200);
    expect(board.summary.needsReplan).toBe(1);
    expect(board.proposal.trigger).toMatch(/no longer provides xray/);

    const c = await catalogue();
    expect(c.services.find((s) => s.code === 'XR').unmet).toEqual([{ capability: 'xray', needed: 1, available: 0 }]);
  });

  it('retires a service: no new bookings, history intact, and it can be restored', async () => {
    const { services } = await catalogue();
    const sc = services.find((s) => s.code === 'SC');
    await json(await call(`/catalogue/services/${sc.id}`, { cookie: manager, method: 'PATCH', body: { active: false } }), 200);
    const refused = await json(await call('/walk-ins', { cookie: manager, body: { patient: { name: 'Synthetic Patient' }, serviceIds: [sc.id] } }), 400);
    expect(refused.error.message).toMatch(/no longer offered/);
    const board = await json(await call('/board', { cookie: manager }), 200);
    expect(board.services.find((s) => s.code === 'SC').active).toBe(false);
    await json(await call(`/catalogue/services/${sc.id}`, { cookie: manager, method: 'PATCH', body: { active: true } }), 200);
  });

  it('edits hours, names and priority levels with validation', async () => {
    await json(await call('/catalogue/centre', { cookie: manager, method: 'PATCH', body: { opensAt: '18:00', closesAt: '09:00' } }), 400);
    const updated = await json(await call('/catalogue/centre', { cookie: manager, method: 'PATCH', body: { city: 'Test City' } }), 200);
    expect(updated.centre.city).toBe('Test City');

    await json(await call('/catalogue/priority-levels/5', { cookie: manager, method: 'PUT', body: { label: 'Urgent', description: 'Same hour' } }), 200);
    const config = await json(await call('/config', { cookie: manager }), 200);
    expect(config.priorityLevels.map((p) => p.label)).toContain('Urgent');
    await json(await call('/catalogue/priority-levels/0', { cookie: manager, method: 'DELETE' }), 400);
    await json(await call('/catalogue/priority-levels/5', { cookie: manager, method: 'DELETE' }), 200);

    const events = await json(await call('/events?limit=50', { cookie: manager }), 200);
    expect(events.filter((e) => e.type === 'catalogue.changed').length).toBeGreaterThan(5);
  });
});

describe('requirement coverage', () => {
  it('needs a distinct resource for each requirement', () => {
    const a = { id: 'a', capabilities: ['ct', 'radiologist'] };
    const b = { id: 'b', capabilities: ['radiologist'] };
    expect(covers(['ct', 'radiologist'], [a, b])).toBe(true);
    expect(covers(['ct', 'radiologist'], [a])).toBe(false);
    expect(covers(['radiologist', 'radiologist'], [a, b])).toBe(true);
  });
});
