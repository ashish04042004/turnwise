/**
 * Accounts, centres people create for themselves, joining with a code,
 * per-centre roles, and PIN sign-in limited to enrolled terminals.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loginFailureKey, signupKey } from '../src/auth.js';
import { closeCache, resetCount } from '../src/cache.js';
import { pool } from '../src/db.js';
import { migrate } from '../src/migrate.js';

const LOCAL = ['127.0.0.1', '::ffff:127.0.0.1', '::1'];
const tag = randomUUID().slice(0, 8);
const emails = [];
let server;
let base;

/** A browser: remembers the cookies the API sets. */
function browser() {
  const jar = new Map();
  const call = async (path, { body, method = body ? 'POST' : 'GET' } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';');
      const [k, v] = pair.split('=');
      if (attrs.some((a) => a.trim() === 'Max-Age=0')) jar.delete(k);
      else jar.set(k, v);
    }
    return res;
  };
  const json = async (path, opts) => {
    const res = await call(path, opts);
    return { status: res.status, body: await res.json() };
  };
  return { call, json, jar };
}

async function newAccount(name) {
  const email = `${name.toLowerCase().replace(/\W+/g, '.')}.${tag}@example.test`;
  emails.push(email);
  const b = browser();
  const res = await b.json('/auth/signup', { body: { name, email, password: 'correct horse battery' } });
  expect(res.status).toBe(201);
  return Object.assign(b, { email });
}

beforeAll(async () => {
  await migrate();
  for (const ip of LOCAL) await resetCount(signupKey(ip));
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}/api`;
});

afterAll(async () => {
  server?.close();
  await pool.query(`DELETE FROM centres WHERE id IN (SELECT s.centre_id FROM staff s JOIN users u ON u.id = s.user_id WHERE u.email = ANY($1)) AND NOT is_demo`, [emails]);
  await pool.query(`DELETE FROM users WHERE email = ANY($1)`, [emails]);
  for (const ip of LOCAL) {
    await resetCount(signupKey(ip));
    await resetCount(loginFailureKey(ip));
  }
  await closeCache();
  await pool.end();
});

describe('accounts', () => {
  it('signs up, rejects duplicates and weak passwords, and has no centre yet', async () => {
    const owner = await newAccount('Owner One');
    const me = await owner.json('/auth/me');
    expect(me.body.user.email).toBe(owner.email);
    expect(me.body.staff).toBeNull();
    expect(me.body.memberships).toEqual([]);
    expect((await owner.call('/board')).status).toBe(401);

    const again = await browser().json('/auth/signup', { body: { name: 'Copy', email: owner.email.toUpperCase(), password: 'another long one' } });
    expect(again.status).toBe(409);
    const weak = await browser().json('/auth/signup', { body: { name: 'Weak', email: `weak.${tag}@example.test`, password: 'short' } });
    expect(weak.status).toBe(400);
  });

  it('signs in with email and password, and rejects a wrong one', async () => {
    const person = await newAccount('Pass Word');
    expect((await browser().json('/auth/password-login', { body: { email: person.email, password: 'wrong password' } })).status).toBe(401);
    const b = browser();
    const ok = await b.json('/auth/password-login', { body: { email: person.email.toUpperCase(), password: 'correct horse battery' } });
    expect(ok.status).toBe(200);
    expect(ok.body.centreId).toBeNull();
    expect((await b.json('/auth/me')).body.user.email).toBe(person.email);
  });
});

describe('a centre of your own', () => {
  let owner;
  let centreId;

  beforeAll(async () => {
    owner = await newAccount('Centre Owner');
    const created = await owner.json('/account/centres', { body: { name: `Own Clinic ${tag}`, city: 'Pune', opensAt: '00:00', closesAt: '23:59' } });
    expect(created.status).toBe(201);
    centreId = created.body.centreId;
  });

  it('makes the creator its manager with every permission, starting from the sample catalogue', async () => {
    const me = (await owner.json('/auth/me')).body;
    expect(me.staff.centre_id).toBe(centreId);
    expect(me.permissions).toEqual(expect.arrayContaining(['roles', 'staff', 'settings', 'frontDesk', 'floor']));
    const catalogue = (await owner.json('/catalogue')).body;
    expect(catalogue.services.length).toBeGreaterThan(0);
    expect((await owner.json('/board')).status).toBe(200);
    const staff = (await owner.json('/staff')).body.staff;
    expect(staff).toEqual([expect.objectContaining({ name: 'Centre Owner', email: owner.email, hasPin: false })]);
  });

  it('stays off the public sign-in list and is never treated as a demo', async () => {
    const { centres } = (await browser().json('/auth/centres')).body;
    expect(centres.map((c) => c.id)).not.toContain(centreId);
    expect((await owner.json('/config')).body.centre.demo).toBe(false);
  });

  it('can start blank', async () => {
    const other = await newAccount('Blank Owner');
    expect((await other.json('/account/centres', { body: { name: `Nowhere ${tag}`, city: 'X', timezone: 'Mars/Olympus' } })).status).toBe(400);
    const created = await other.json('/account/centres', { body: { name: `Blank ${tag}`, city: 'Goa', starter: 'blank' } });
    expect(created.status).toBe(201);
    expect((await other.json('/catalogue')).body.services).toEqual([]);
  });

  describe('joining with the centre’s code', () => {
    let applicant;
    let requestId;

    it('lets someone ask to join, and the manager approve them with a role', async () => {
      const { code } = (await owner.json('/centre/join-code')).body;
      expect(code).toMatch(/^[A-Z0-9]{8}$/);

      applicant = await newAccount('New Joiner');
      expect((await applicant.json('/account/join', { body: { code: 'NOPE0000' } })).status).toBe(404);
      const asked = await applicant.json('/account/join', { body: { code: `${code.slice(0, 4).toLowerCase()}-${code.slice(4)}`, message: 'Starting Monday' } });
      expect(asked.status).toBe(201);
      requestId = asked.body.id;
      expect((await applicant.json('/account/join', { body: { code } })).status).toBe(409);
      expect((await applicant.json('/auth/me')).body.requests[0]).toMatchObject({ status: 'pending' });

      const pending = (await owner.json('/join-requests')).body.requests;
      expect(pending).toEqual([expect.objectContaining({ id: requestId, email: applicant.email, message: 'Starting Monday' })]);
      expect((await owner.json(`/join-requests/${requestId}/approve`, { body: { role: 'reception' } })).status).toBe(200);
      expect((await owner.json('/join-requests')).body.requests).toEqual([]);

      const me = (await applicant.json('/auth/me')).body;
      expect(me.memberships).toEqual([expect.objectContaining({ centreId, role: 'reception' })]);
      expect(me.staff).toBeNull();
      expect((await applicant.json('/account/switch', { body: { centreId } })).status).toBe(200);
      const inside = (await applicant.json('/auth/me')).body;
      expect(inside.staff.role).toBe('reception');
      expect(inside.permissions).toContain('frontDesk');
      expect(inside.permissions).not.toContain('staff');
    });

    it('refuses switching into a centre you don’t belong to', async () => {
      const stranger = await newAccount('Stranger');
      expect((await stranger.json('/account/switch', { body: { centreId } })).status).toBe(403);
    });

    it('turns the code off and on again', async () => {
      expect((await owner.json('/centre/join-code', { method: 'DELETE' })).body.code).toBeNull();
      const { code } = (await owner.json('/centre/join-code', { body: {} })).body;
      expect(code).toMatch(/^[A-Z0-9]{8}$/);
    });

    describe('roles', () => {
      it('lets the centre add a role, pick its permissions, and changes access at once', async () => {
        const added = await owner.json('/roles', { body: { code: 'Auditor', label: 'Auditor', permissions: ['floor'] } });
        expect(added.status).toBe(201);
        expect(added.body).toMatchObject({ code: 'auditor', permissions: ['floor'] });
        expect((await owner.json('/roles', { body: { code: 'auditor', label: 'Again', permissions: [] } })).status).toBe(409);
        expect((await owner.json('/roles', { body: { code: 'bad', label: 'Bad', permissions: ['launchRockets'] } })).status).toBe(400);

        // Front desk staff lose a permission the moment their role does, without signing in again.
        expect((await applicant.json('/replan', { body: {} })).status).not.toBe(403);
        const before = (await owner.json('/roles')).body.roles.find((r) => r.code === 'reception');
        expect((await owner.json('/roles/reception', { method: 'PATCH', body: { permissions: ['frontDesk'] } })).status).toBe(200);
        expect((await applicant.json('/replan', { body: {} })).status).toBe(403);
        expect((await owner.json('/roles/reception', { method: 'PATCH', body: { permissions: before.permissions } })).status).toBe(200);

        expect((await applicant.json('/roles')).status).toBe(403);
      });

      it('never lets a centre lock itself out', async () => {
        const manager = (await owner.json('/roles')).body.roles.find((r) => r.code === 'manager');
        const res = await owner.json('/roles/manager', { method: 'PATCH', body: { permissions: manager.permissions.filter((p) => p !== 'roles') } });
        expect(res.status).toBe(409);
        expect(res.body.error.message).toMatch(/manage roles/);
        expect((await owner.json('/roles/manager', { method: 'DELETE' })).status).toBe(409);
        expect((await owner.json('/roles/auditor', { method: 'DELETE' })).status).toBe(200);
      });

      it('stops people who manage staff from handing out more than they have', async () => {
        expect((await owner.json('/roles', { body: { code: 'lead', label: 'Desk lead', permissions: ['frontDesk', 'staff'] } })).status).toBe(201);
        const me = (await applicant.json('/auth/me')).body;
        expect((await owner.json(`/staff/${me.staff.id}`, { method: 'PATCH', body: { role: 'lead' } })).status).toBe(200);
        // The role change signed them out of the centre; back in as a desk lead.
        expect((await applicant.json('/account/switch', { body: { centreId } })).status).toBe(200);

        const staff = (await applicant.json('/staff')).body.staff;
        const ownerRow = staff.find((s) => s.email === owner.email);
        expect((await applicant.json(`/staff/${ownerRow.id}`, { method: 'PATCH', body: { active: false } })).status).toBe(403);
        expect((await applicant.json('/staff', { body: { name: 'Sneaky Manager', role: 'manager', pin: '4321' } })).status).toBe(403);
        expect((await applicant.json('/staff', { body: { name: 'Front Desk Two', role: 'lead', pin: '4321' } })).status).toBe(201);
      });
    });
  });

  describe('PIN sign-in on shared terminals', () => {
    let pinStaff;

    beforeAll(async () => {
      const added = await owner.json('/staff', { body: { name: `Desk PIN ${tag}`.slice(0, 60), role: 'reception', pin: '2468' } });
      expect(added.status).toBe(201);
      pinStaff = added.body.id;
    });

    it('is refused on a device the centre has not enrolled', async () => {
      const desk = browser();
      expect((await desk.json(`/auth/staff?centreId=${centreId}`)).status).toBe(403);
      expect((await desk.json('/auth/login', { body: { staffId: pinStaff, pin: '2468' } })).status).toBe(403);
    });

    it('works once a manager enrols the device, and stops when it is revoked', async () => {
      const desk = browser();
      expect((await desk.json('/account/switch', { body: { centreId } })).status).toBe(401);
      // A manager signs in on the desk computer and enrols it.
      expect((await desk.json('/auth/password-login', { body: { email: owner.email, password: 'correct horse battery' } })).status).toBe(200);
      const enrolled = await desk.json('/terminals', { body: { name: 'Front desk 1' } });
      expect(enrolled.status).toBe(201);
      expect(desk.jar.has('tw_terminal')).toBe(true);
      expect((await desk.json('/auth/logout', { body: {} })).status).toBe(200);

      const centres = (await desk.json('/auth/centres')).body;
      expect(centres.terminal).toMatchObject({ name: 'Front desk 1', centre: { id: centreId } });
      const directory = (await desk.json('/auth/staff')).body;
      expect(directory.centre.id).toBe(centreId);
      expect(directory.staff.map((s) => s.id)).toContain(pinStaff);
      expect((await desk.json('/auth/login', { body: { staffId: pinStaff, pin: '2468' } })).status).toBe(200);
      expect((await desk.json('/auth/me')).body).toMatchObject({ user: null, staff: { id: pinStaff } });

      expect((await owner.json(`/terminals/${enrolled.body.id}`, { method: 'DELETE' })).status).toBe(200);
      expect((await desk.json('/auth/login', { body: { staffId: pinStaff, pin: '2468' } })).status).toBe(403);
    });
  });

  describe('sessions', () => {
    it('lands in the centre on sign-in when the account has exactly one', async () => {
      const b = browser();
      const res = await b.json('/auth/password-login', { body: { email: owner.email, password: 'correct horse battery' } });
      expect(res.body.centreId).toBe(centreId);
      expect((await b.json('/board')).status).toBe(200);
    });

    it('signs out of this device only, unless asked to sign out everywhere', async () => {
      const [laptop, phone] = [browser(), browser()];
      for (const b of [laptop, phone]) await b.json('/auth/password-login', { body: { email: owner.email, password: 'correct horse battery' } });
      const stolen = laptop.jar.get('tw_session');
      expect((await laptop.json('/auth/logout', { body: {} })).status).toBe(200);
      expect((await laptop.json('/auth/me')).status).toBe(401);
      expect((await phone.json('/board')).status).toBe(200);

      laptop.jar.set('tw_session', stolen);
      expect((await phone.json('/auth/logout', { body: { everywhere: true } })).status).toBe(200);
      expect((await laptop.json('/auth/me')).status).toBe(401);
      expect((await owner.json('/auth/me')).status).toBe(401);
      await owner.json('/auth/password-login', { body: { email: owner.email, password: 'correct horse battery' } });
      expect((await owner.json('/board')).status).toBe(200);
    });

    it('signs out everywhere when the password changes', async () => {
      const elsewhere = browser();
      await elsewhere.json('/auth/password-login', { body: { email: owner.email, password: 'correct horse battery' } });
      expect((await owner.json('/account/password', { method: 'PUT', body: { current: 'nope', next: 'a brand new passphrase' } })).status).toBe(400);
      expect((await owner.json('/account/password', { method: 'PUT', body: { current: 'correct horse battery', next: 'a brand new passphrase' } })).status).toBe(200);
      expect((await elsewhere.json('/auth/me')).status).toBe(401);
      expect((await owner.json('/board')).status).toBe(200);
      expect((await browser().json('/auth/password-login', { body: { email: owner.email, password: 'a brand new passphrase' } })).status).toBe(200);
    });
  });
});
