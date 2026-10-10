import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { hashSecret, verifySecret } from '../auth.js';
import { invalidate, keys } from '../cache.js';
import { badRequest, conflict, notFound, pool, withTx } from '../db.js';
import { recordEvent } from '../events.js';
import { loadFixture } from '../seed.js';
import { provisionCentre } from './provisioning.js';
import { assertCanGrant, assertCentreGoverned, lockCentreAccess } from './roles.js';

const email = z.string().trim().toLowerCase().max(200).email('enter a valid email address');
const password = z.string().min(10, 'passwords need at least 10 characters').max(200);
const personName = z.string().trim().min(2, 'name is required').max(60);
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'times are HH:MM (24-hour)');
const joinCode = z
  .string()
  .trim()
  .toUpperCase()
  .transform((s) => s.replace(/[^A-Z0-9]/g, ''))
  .pipe(z.string().regex(/^[A-Z0-9]{8}$/, 'join codes are 8 letters and digits'));

function validZone(zone) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export const accountSchemas = {
  signup: z.object({ name: personName, email, password }).strict(),
  login: z.object({ email, password: z.string().min(1).max(200) }).strict(),
  password: z.object({ current: z.string().min(1).max(200), next: password }).strict(),
  createCentre: z
    .object({
      name: z.string().trim().min(2).max(80),
      city: z.string().trim().min(1).max(80),
      timezone: z.string().trim().min(1).max(60).refine(validZone, 'use a time zone like Asia/Kolkata').default('Asia/Kolkata'),
      opensAt: clock.default('08:00'),
      closesAt: clock.default('20:00'),
      starter: z.enum(['sample', 'blank']).default('sample'),
    })
    .strict()
    .refine((c) => c.opensAt < c.closesAt, { message: 'the centre must open before it closes', path: ['closesAt'] }),
  join: z.object({ code: joinCode, message: z.string().trim().max(300).optional() }).strict(),
  decide: z.object({ role: z.string().trim().min(1).max(40) }).strict(),
  terminal: z.object({ name: z.string().trim().min(2).max(60) }).strict(),
};

// No 0/O or 1/I, so codes read aloud or copied by hand survive.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const newJoinCode = () => Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');

export async function signup({ name, email: address, password: secret }) {
  try {
    const { rows } = await pool.query(`INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id, email, name, session_version`, [
      address,
      name,
      hashSecret(secret),
    ]);
    return rows[0];
  } catch (err) {
    if (err.code === '23505') throw conflict('An account with that email already exists; sign in instead');
    throw err;
  }
}

/** Changing the password signs the account out everywhere else. */
export async function changePassword(user, { current, next }) {
  const { rows } = await pool.query(`SELECT password_hash FROM users WHERE id = $1`, [user.id]);
  if (!rows[0] || !verifySecret(current, rows[0].password_hash)) throw badRequest('Your current password is not right');
  const { rows: updated } = await pool.query(
    `UPDATE users SET password_hash = $2, session_version = session_version + 1 WHERE id = $1 RETURNING id, email, name, session_version`,
    [user.id, hashSecret(next)],
  );
  await invalidate(keys.user(user.id));
  return updated[0];
}

export async function pendingRequestsOf(userId) {
  const { rows } = await pool.query(
    `SELECT r.id, r.status, r.created_at AS "createdAt", r.decided_at AS "decidedAt", c.name AS "centreName", c.city
     FROM join_requests r JOIN centres c ON c.id = r.centre_id
     WHERE r.user_id = $1 AND (r.status = 'pending' OR r.decided_at > now() - interval '14 days')
     ORDER BY r.created_at DESC`,
    [userId],
  );
  return rows;
}

/** The fixture's first centre as a starting catalogue: services, resources and demand, but no people or history. */
async function sampleCatalogue() {
  const { centres } = await loadFixture();
  const {
    activity: _activity,
    staff: _staff,
    name: _name,
    city: _city,
    timezone: _tz,
    hours: _hours,
    settings: { demo_sign_in_hint: _hint, ...settings } = {},
    ...catalogue
  } = centres[0];
  return { ...catalogue, settings };
}

/**
 * Creates a centre owned by the account: the creator joins with the role
 * that can do the most, which is given every permission so nothing is out of
 * reach on day one.
 */
export async function createCentre(user, input) {
  const starter = input.starter === 'sample' ? await sampleCatalogue() : {};
  const result = await withTx(async (tx) => {
    const { centre } = await provisionCentre(tx, {
      ...starter,
      name: input.name,
      city: input.city,
      timezone: input.timezone,
      hours: { opens: input.opensAt, closes: input.closesAt },
      displayOrder: 1000,
      demo: false,
      joinCode: newJoinCode(),
      staff: [],
    });
    const { rows: top } = await tx.query(
      `SELECT r.code FROM centre_roles r LEFT JOIN centre_role_permissions p ON p.centre_id = r.centre_id AND p.role_code = r.code
       WHERE r.centre_id = $1 GROUP BY r.code, r.sort_order ORDER BY count(p.permission_code) DESC, r.sort_order LIMIT 1`,
      [centre.id],
    );
    let role = top[0]?.code;
    if (!role) {
      role = 'owner';
      await tx.query(`INSERT INTO centre_roles (centre_id, code, label) VALUES ($1, 'owner', 'Owner')`, [centre.id]);
    }
    await tx.query(
      `INSERT INTO centre_role_permissions (centre_id, role_code, permission_code) SELECT $1, $2, code FROM permissions ON CONFLICT DO NOTHING`,
      [centre.id, role],
    );
    const { rows } = await tx.query(`INSERT INTO staff (centre_id, name, role, user_id) VALUES ($1, $2, $3, $4) RETURNING id, session_version`, [
      centre.id,
      user.name,
      role,
      user.id,
    ]);
    await recordEvent(tx, centre.id, 'centre.created', centre.id, { name: centre.name, starter: input.starter }, `${user.name} (${role})`);
    return { centreId: centre.id, staffId: rows[0].id, session_version: rows[0].session_version };
  });
  return result;
}

export async function requestToJoin(user, { code, message }) {
  const { rows: centres } = await pool.query(`SELECT id, name FROM centres WHERE join_code = $1 AND NOT is_demo`, [code]);
  const centre = centres[0];
  if (!centre) throw notFound('A centre with that join code');
  const { rows: member } = await pool.query(`SELECT active FROM staff WHERE centre_id = $1 AND user_id = $2`, [centre.id, user.id]);
  if (member[0]?.active) throw conflict(`You already work at ${centre.name}`);
  try {
    return await withTx(async (tx) => {
      const { rows } = await tx.query(`INSERT INTO join_requests (centre_id, user_id, message) VALUES ($1, $2, $3) RETURNING id, status, created_at AS "createdAt"`, [
        centre.id,
        user.id,
        message || null,
      ]);
      await recordEvent(tx, centre.id, 'join.requested', rows[0].id, { name: user.name, email: user.email }, `${user.name} (applicant)`);
      return { ...rows[0], centreName: centre.name };
    });
  } catch (err) {
    if (err.code === '23505') throw conflict(`You have already asked to join ${centre.name}; a manager will review it`);
    throw err;
  }
}

export async function withdrawRequest(user, requestId) {
  const { rowCount } = await pool.query(
    `UPDATE join_requests SET status = 'withdrawn', decided_at = now(), decided_by = 'applicant' WHERE id = $1 AND user_id = $2 AND status = 'pending'`,
    [requestId, user.id],
  );
  if (!rowCount) throw notFound('Pending request');
}

export async function listJoinRequests(centreId) {
  const { rows } = await pool.query(
    `SELECT r.id, r.message, r.created_at AS "createdAt", u.name, u.email
     FROM join_requests r JOIN users u ON u.id = r.user_id
     WHERE r.centre_id = $1 AND r.status = 'pending' ORDER BY r.created_at`,
    [centreId],
  );
  return rows;
}

/** Approving makes the applicant a member with the chosen role (reactivating them if they worked here before). */
export async function decideJoinRequest(centreId, requestId, { approve, role }, { actor, actorRole }) {
  if (approve) await assertCanGrant(centreId, actorRole, role);
  const result = await withTx(async (tx) => {
    await lockCentreAccess(tx, centreId);
    const { rows } = await tx.query(
      `SELECT r.id, r.user_id, u.name, u.email FROM join_requests r JOIN users u ON u.id = r.user_id
       WHERE r.id = $1 AND r.centre_id = $2 AND r.status = 'pending' FOR UPDATE OF r`,
      [requestId, centreId],
    );
    const request = rows[0];
    if (!request) throw notFound('Pending request');
    await tx.query(`UPDATE join_requests SET status = $2, decided_at = now(), decided_by = $3 WHERE id = $1`, [requestId, approve ? 'approved' : 'rejected', actor]);
    let staffId = null;
    if (approve) {
      const { rows: existing } = await tx.query(`SELECT id FROM staff WHERE centre_id = $1 AND user_id = $2`, [centreId, request.user_id]);
      if (existing[0]) {
        staffId = existing[0].id;
        await tx.query(`UPDATE staff SET active = true, role = $2, session_version = session_version + 1 WHERE id = $1`, [staffId, role]);
      } else {
        const { rows: taken } = await tx.query(`SELECT 1 FROM staff WHERE centre_id = $1 AND name = $2`, [centreId, request.name]);
        const name = taken[0] ? `${request.name} (${request.email.split('@')[0]})`.slice(0, 60) : request.name;
        const { rows: added } = await tx.query(`INSERT INTO staff (centre_id, name, role, user_id) VALUES ($1, $2, $3, $4) RETURNING id`, [
          centreId,
          name,
          role,
          request.user_id,
        ]);
        staffId = added[0].id;
      }
      await assertCentreGoverned(tx, centreId);
    }
    await recordEvent(tx, centreId, approve ? 'join.approved' : 'join.rejected', staffId ?? requestId, { name: request.name, email: request.email, role: approve ? role : undefined }, actor);
    return { staffId };
  });
  if (result.staffId) await invalidate(keys.staff(result.staffId));
  return result;
}

// Join codes ---------------------------------------------------------------------

async function nonDemo(centreId) {
  const { rows } = await pool.query(`SELECT is_demo, join_code FROM centres WHERE id = $1`, [centreId]);
  if (!rows[0]) throw notFound('Centre');
  if (rows[0].is_demo) throw badRequest('Demo centres are rebuilt every day, so they don’t take join requests; create your own centre instead');
  return rows[0];
}

export async function getJoinCode(centreId) {
  const { rows } = await pool.query(`SELECT is_demo, join_code FROM centres WHERE id = $1`, [centreId]);
  return { code: rows[0]?.join_code ?? null, demo: Boolean(rows[0]?.is_demo) };
}

export async function setJoinCode(centreId, enabled, actor) {
  await nonDemo(centreId);
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = enabled ? newJoinCode() : null;
    try {
      await withTx(async (tx) => {
        await tx.query(`UPDATE centres SET join_code = $2 WHERE id = $1`, [centreId, code]);
        await recordEvent(tx, centreId, 'join.code_changed', centreId, { enabled }, actor);
      });
      return { code, demo: false };
    } catch (err) {
      if (err.code !== '23505') throw err;
    }
  }
  throw conflict('Could not pick a fresh join code; try again');
}

// Shared terminals -----------------------------------------------------------------

export async function listTerminals(centreId) {
  const { rows } = await pool.query(
    `SELECT id, name, created_by AS "createdBy", created_at AS "createdAt" FROM terminals WHERE centre_id = $1 AND revoked_at IS NULL ORDER BY created_at`,
    [centreId],
  );
  return rows;
}

export async function enrolTerminal(centreId, { name }, actor) {
  return withTx(async (tx) => {
    const { rows } = await tx.query(`INSERT INTO terminals (centre_id, name, created_by) VALUES ($1, $2, $3) RETURNING id, name, centre_id`, [centreId, name, actor]);
    await recordEvent(tx, centreId, 'terminal.enrolled', rows[0].id, { name }, actor);
    return rows[0];
  });
}

export async function revokeTerminal(centreId, terminalId, actor) {
  await withTx(async (tx) => {
    const { rows } = await tx.query(`UPDATE terminals SET revoked_at = now() WHERE id = $1 AND centre_id = $2 AND revoked_at IS NULL RETURNING name`, [
      terminalId,
      centreId,
    ]);
    if (!rows[0]) throw notFound('Terminal');
    await recordEvent(tx, centreId, 'terminal.revoked', terminalId, { name: rows[0].name }, actor);
  });
}
