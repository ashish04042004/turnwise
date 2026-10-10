/**
 * HTTP-level checks for sign-in and role-based access, against an isolated
 * test centre on the real Postgres.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loginFailureKey } from '../src/auth.js';
import { closeCache, resetCount } from '../src/cache.js';
import { pool } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { provisionCentre } from '../src/services/provisioning.js';

let server;
let base;
let centreId;
const staff = {};

beforeAll(async () => {
  await migrate();
  const provisioned = await provisionCentre(pool, {
    name: 'API Test Centre',
    city: 'Test',
    hours: { opens: '00:00', closes: '23:59' },
    // Sorts after real centres, so it never becomes the default.
    displayOrder: 1000,
    // PIN sign-in from any device, like the public demo centres.
    demo: true,
    staff: [
      { name: 'Test reception', role: 'reception', pin: '1111' },
      { name: 'Test technician', role: 'technician', pin: '2222' },
      { name: 'Test manager', role: 'manager', pin: '3333' },
    ],
    priorityLevels: [
      { level: 0, label: 'Standard' },
      { level: 4, label: 'Soon' },
    ],
  });
  centreId = provisioned.centre.id;
  for (const s of provisioned.staff) staff[s.role] = s.id;
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}/api`;
});

afterAll(async () => {
  server?.close();
  if (centreId) await pool.query('DELETE FROM centres WHERE id = $1', [centreId]);
  await closeCache();
  await pool.end();
});

const call = (path, { cookie, body, method = body ? 'POST' : 'GET' } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

async function signIn(role, pin) {
  const res = await call('/auth/login', { body: { staffId: staff[role], pin } });
  expect(res.status).toBe(200);
  return res.headers.getSetCookie()[0].split(';')[0];
}

describe('staff sign-in', () => {
  it('rejects staff endpoints without a session', async () => {
    expect((await call('/board')).status).toBe(401);
    expect((await call('/walk-ins', { body: {} })).status).toBe(401);
  });

  it('keeps patient links and health checks public', async () => {
    expect((await call('/health')).status).toBe(200);
    expect((await call('/public/visits/does-not-exist')).status).toBe(404);
  });

  it('rejects a wrong PIN', async () => {
    const res = await call('/auth/login', { body: { staffId: staff.reception, pin: '9999' } });
    expect(res.status).toBe(401);
  });

  it('issues an HttpOnly session scoped to the person’s centre and role', async () => {
    const res = await call('/auth/login', { body: { staffId: staff.reception, pin: '1111' } });
    const setCookie = res.headers.getSetCookie()[0];
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    const cookie = setCookie.split(';')[0];

    const me = await (await call('/auth/me', { cookie })).json();
    expect(me.staff.role).toBe('reception');
    expect(me.permissions).toContain('frontDesk');
    expect(me.permissions).not.toContain('floor');

    const board = await call('/board', { cookie });
    expect(board.status).toBe(200);
    expect((await board.json()).centre.name).toBe('API Test Centre');
  });

  it('rejects a tampered session token', async () => {
    const cookie = await signIn('reception', '1111');
    const [name, value] = cookie.split('=');
    const [body, mac] = value.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), s: staff.manager })).toString('base64url');
    expect((await call('/board', { cookie: `${name}=${forged}.${mac}` })).status).toBe(401);
  });
});

describe('role-based access', () => {
  it('lets only floor staff start services', async () => {
    const reception = await signIn('reception', '1111');
    const res = await call(`/steps/${randomUUID()}/start`, { cookie: reception, body: {} });
    expect(res.status).toBe(403);
    const technician = await signIn('technician', '2222');
    expect((await call(`/steps/${randomUUID()}/start`, { cookie: technician, body: {} })).status).toBe(404);
  });

  it('lets only coordinators apply re-plans', async () => {
    const technician = await signIn('technician', '2222');
    expect((await call(`/proposals/${randomUUID()}/apply`, { cookie: technician, body: { option: 'contain' } })).status).toBe(403);
    const manager = await signIn('manager', '3333');
    expect((await call(`/proposals/${randomUUID()}/apply`, { cookie: manager, body: { option: 'contain' } })).status).toBe(404);
  });

  it('records the signed-in person, not a client-supplied name, in the audit trail', async () => {
    const machine = (await pool.query(`INSERT INTO resources (centre_id, name, kind, capabilities) VALUES ($1, 'Test Analyser', 'equipment', '{test}') RETURNING id`, [centreId]))
      .rows[0].id;
    const technician = await signIn('technician', '2222');
    const res = await fetch(`${base}/resources/${machine}/down`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: technician, 'x-actor': 'someone-else' },
      body: JSON.stringify({ minutes: 15, reason: 'calibration' }),
    });
    expect(res.status).toBe(200);
    const events = await (await call('/events?limit=5', { cookie: technician })).json();
    expect(events.find((e) => e.type === 'resource.down').actor).toBe('Test technician (technician)');
  });
});

describe('staff management', () => {
  it('is for managers only', async () => {
    const reception = await signIn('reception', '1111');
    expect((await call('/staff', { cookie: reception })).status).toBe(403);
    expect((await call('/staff', { cookie: reception, body: { name: 'Sneaky', role: 'manager', pin: '1234' } })).status).toBe(403);
  });

  it('adds a person who can then sign in, and rejects duplicate names', async () => {
    const manager = await signIn('manager', '3333');
    const added = await call('/staff', { cookie: manager, body: { name: 'New Hire', role: 'technician', pin: '4444' } });
    expect(added.status).toBe(201);
    const { id } = await added.json();
    expect((await call('/auth/login', { body: { staffId: id, pin: '4444' } })).status).toBe(200);
    expect((await call('/staff', { cookie: manager, body: { name: 'New Hire', role: 'reception', pin: '5555' } })).status).toBe(409);
    const list = await (await call('/staff', { cookie: manager })).json();
    expect(list.staff.map((s) => s.name)).toContain('New Hire');
    expect(JSON.stringify(list)).not.toMatch(/pin_hash|scrypt/);
  });

  it('signs a person out everywhere when their role, PIN or status changes', async () => {
    const manager = await signIn('manager', '3333');
    const { id } = await (await call('/staff', { cookie: manager, body: { name: 'Temp Cover', role: 'reception', pin: '6666' } })).json();
    const login = await call('/auth/login', { body: { staffId: id, pin: '6666' } });
    const theirs = login.headers.getSetCookie()[0].split(';')[0];
    expect((await call('/board', { cookie: theirs })).status).toBe(200);

    expect((await call(`/staff/${id}`, { cookie: manager, method: 'PATCH', body: { pin: '7777' } })).status).toBe(200);
    expect((await call('/board', { cookie: theirs })).status).toBe(401);
    expect((await call('/auth/login', { body: { staffId: id, pin: '6666' } })).status).toBe(401);
    expect((await call('/auth/login', { body: { staffId: id, pin: '7777' } })).status).toBe(200);

    expect((await call(`/staff/${id}`, { cookie: manager, method: 'PATCH', body: { active: false } })).status).toBe(200);
    expect((await call('/auth/login', { body: { staffId: id, pin: '7777' } })).status).toBe(401);
    const picker = await (await call(`/auth/staff?centreId=${centreId}`)).json();
    expect(picker.centre.name).toBe('API Test Centre');
    expect(picker.staff.map((s) => s.name)).toContain('Test manager');
    expect(picker.staff.some((s) => s.id === id)).toBe(false);

    const events = await (await call('/events?limit=10', { cookie: manager })).json();
    const updates = events.filter((e) => e.type === 'staff.updated' && e.subject_id === id);
    expect(updates.length).toBe(2);
    expect(JSON.stringify(updates)).not.toMatch(/7777/);
  });

  it('keeps at least one active manager and stops managers locking themselves out', async () => {
    const manager = await signIn('manager', '3333');
    expect((await call(`/staff/${staff.manager}`, { cookie: manager, method: 'PATCH', body: { role: 'reception' } })).status).toBe(409);
    expect((await call(`/staff/${staff.manager}`, { cookie: manager, method: 'PATCH', body: { active: false } })).status).toBe(409);

    // Changing your own PIN keeps you signed in on this device.
    const own = await call(`/staff/${staff.manager}`, { cookie: manager, method: 'PATCH', body: { pin: '3333' } });
    expect(own.status).toBe(200);
    const renewed = own.headers.getSetCookie()[0].split(';')[0];
    expect((await call('/staff', { cookie: renewed })).status).toBe(200);
    expect((await call('/staff', { cookie: manager })).status).toBe(401);
  });

  it('cannot touch staff at another centre', async () => {
    const manager = await signIn('manager', '3333');
    const other = (await pool.query(`SELECT id FROM staff WHERE centre_id <> $1 LIMIT 1`, [centreId])).rows[0];
    if (other) expect((await call(`/staff/${other.id}`, { cookie: manager, method: 'PATCH', body: { active: false } })).status).toBe(404);
  });
});

describe('configuration from the database', () => {
  it('gives each role the centre’s options, and setting definitions only to those who can change them', async () => {
    const technician = await (await call('/config', { cookie: await signIn('technician', '2222') })).json();
    expect(technician.centre.name).toBe('API Test Centre');
    expect(technician.priorityLevels.map((p) => p.label)).toEqual(['Standard', 'Soon']);
    expect(technician.roles.map((r) => r.code)).toEqual(expect.arrayContaining(['manager', 'reception', 'technician']));
    expect(technician.permissions).toContain('floor');
    expect(technician.settings.slot_search_options).toBe(5);
    expect(technician.settingDefinitions).toBeUndefined();

    const manager = await (await call('/config', { cookie: await signIn('manager', '3333') })).json();
    expect(manager.settingDefinitions.find((d) => d.key === 'slot_search_options')).toMatchObject({ valueType: 'integer', min: 1, max: 20 });
  });

  it('lets managers change a setting within its bounds, audits it, and resets it to the default', async () => {
    const reception = await signIn('reception', '1111');
    expect((await call('/settings/slot_search_options', { cookie: reception, method: 'PUT', body: { value: 3 } })).status).toBe(403);

    const manager = await signIn('manager', '3333');
    expect((await call('/settings/slot_search_options', { cookie: manager, method: 'PUT', body: { value: 999 } })).status).toBe(400);
    expect((await call('/settings/slot_search_options', { cookie: manager, method: 'PUT', body: { value: 2.5 } })).status).toBe(400);
    expect((await call('/settings/no_such_setting', { cookie: manager, method: 'PUT', body: { value: 1 } })).status).toBe(404);

    expect((await call('/settings/slot_search_options', { cookie: manager, method: 'PUT', body: { value: 3 } })).status).toBe(200);
    let cfg = await (await call('/config', { cookie: manager })).json();
    expect(cfg.settings.slot_search_options).toBe(3);
    expect(cfg.overrides.map((o) => o.key)).toContain('slot_search_options');

    const events = await (await call('/events?limit=5', { cookie: manager })).json();
    expect(events.find((e) => e.type === 'settings.changed').payload).toMatchObject({ key: 'slot_search_options', from: 5, to: 3 });

    expect((await call('/settings/slot_search_options', { cookie: manager, method: 'DELETE' })).status).toBe(200);
    cfg = await (await call('/config', { cookie: manager })).json();
    expect(cfg.settings.slot_search_options).toBe(5);
  });

  it('only accepts priority levels the centre has configured', async () => {
    const reception = await signIn('reception', '1111');
    const res = await call('/walk-ins', { cookie: reception, body: { patient: { name: 'Priority Test' }, serviceIds: [randomUUID()], priority: 2 } });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/Priority 2/);
  });

  it('lists centres for the sign-in screen', async () => {
    const { centres } = await (await call('/auth/centres')).json();
    expect(centres.map((c) => c.name)).toContain('API Test Centre');
  });
});

describe('session lifecycle', () => {
  it('revokes the session on sign-out', async () => {
    const cookie = await signIn('manager', '3333');
    expect((await call('/auth/logout', { cookie, body: {} })).status).toBe(200);
    expect((await call('/board', { cookie })).status).toBe(401);
  });

  it('slows down PIN guessing', async () => {
    let last;
    for (let i = 0; i < 9; i++) last = await call('/auth/login', { body: { staffId: staff.technician, pin: '0000' } });
    expect(last.status).toBe(429);
    // The count is shared through Redis; don't leave this address locked out for the next run.
    for (const ip of ['127.0.0.1', '::ffff:127.0.0.1', '::1']) await resetCount(loginFailureKey(ip));
  });
});
