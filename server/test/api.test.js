/**
 * HTTP-level checks for sign-in and role-based access, against an isolated
 * test centre on the real Postgres.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { hashPin } from '../src/auth.js';
import { pool } from '../src/db.js';
import { migrate } from '../src/migrate.js';

let server;
let base;
let centreId;
const staff = {};

beforeAll(async () => {
  await migrate();
  centreId = (
    await pool.query(`INSERT INTO centres (name, city, timezone, opens_at, closes_at) VALUES ('API Test Centre', 'Test', 'Asia/Kolkata', '00:00', '23:59') RETURNING id`)
  ).rows[0].id;
  for (const [role, pin] of [
    ['reception', '1111'],
    ['technician', '2222'],
    ['manager', '3333'],
  ]) {
    staff[role] = (
      await pool.query(`INSERT INTO staff (centre_id, name, role, pin_hash) VALUES ($1, $2, $3, $4) RETURNING id`, [centreId, `Test ${role}`, role, hashPin(pin)])
    ).rows[0].id;
  }
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}/api`;
});

afterAll(async () => {
  server?.close();
  if (centreId) await pool.query('DELETE FROM centres WHERE id = $1', [centreId]);
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
  });
});
