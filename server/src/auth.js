import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { cached, countHit, invalidate, keys, peekCount, resetCount } from './cache.js';
import { config } from './config.js';
import { HttpError, pool } from './db.js';
import { getReference, permissionsOf } from './services/reference.js';

const COOKIE = 'tw_session';

export function hashPin(pin) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${scryptSync(pin, salt, 32).toString('base64')}`;
}

export function verifyPin(pin, stored) {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = scryptSync(pin, Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

const sign = (data) => createHmac('sha256', config.sessionSecret).update(data).digest('base64url');

export function issueToken(staff, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ s: staff.id, v: staff.session_version, e: now + config.sessionHours * 3_600_000 })).toString('base64url');
  return `${body}.${sign(body)}`;
}

export function readToken(token, now = Date.now()) {
  const [body, mac] = String(token ?? '').split('.');
  if (!body || !mac) return null;
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
    return claims.e > now ? claims : null;
  } catch {
    return null;
  }
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function setSessionCookie(res, token, maxAgeSec) {
  const attrs = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (config.production) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

/**
 * Who holds a session, cached because every request asks. Anything that
 * revokes a session (logout, PIN reset, role change, deactivation) bumps
 * session_version and invalidates this key; the staff trigger covers edits
 * made directly in the database.
 */
const sessionHolder = (staffId) =>
  cached(keys.staff(staffId), config.cache.staffSeconds, async () => {
    const { rows } = await pool.query(`SELECT id, centre_id, name, role, session_version, active FROM staff WHERE id = $1`, [staffId]);
    return rows[0] ?? null;
  });

/** Attaches req.staff when the session cookie is valid and its holder is still active. */
export async function authenticate(req, _res, next) {
  const claims = readToken(readCookie(req, COOKIE));
  if (claims) {
    const staff = await sessionHolder(claims.s);
    if (staff?.active && staff.session_version === claims.v) {
      const { active: _active, ...rest } = staff;
      req.staff = rest;
    }
  }
  next();
}

export function requireStaff(req, _res, next) {
  if (!req.staff) throw new HttpError(401, 'unauthenticated', 'Sign in to continue');
  next();
}

/** Allows the request when the caller's role has been granted `permission` (role_permissions table). */
export const requirePermission = (permission) => async (req, _res, next) => {
  if (!req.staff) throw new HttpError(401, 'unauthenticated', 'Sign in to continue');
  if (!(await permissionsOf(req.staff.role)).includes(permission)) {
    const { roles } = await getReference();
    const allowed = roles.filter((r) => r.permissions.includes(permission)).map((r) => r.label);
    throw new HttpError(403, 'forbidden', allowed.length ? `Only ${allowed.join(' or ')} staff can do this` : 'Nobody is allowed to do this');
  }
  next();
};

export const actorOf = (req) => `${req.staff.name} (${req.staff.role})`;

// Failed sign-ins per client address, counted across replicas; PINs are short, so guessing must be slow.
export const loginFailureKey = (ip) => `login-failures:${ip ?? 'unknown'}`;

export async function login(req, res, { staffId, pin }) {
  const key = loginFailureKey(req.ip);
  if ((await peekCount(key)) >= config.login.maxFailures) {
    throw new HttpError(429, 'too_many_attempts', 'Too many failed sign-ins; try again in a few minutes');
  }
  const { rows } = await pool.query(`SELECT id, centre_id, name, role, pin_hash, session_version FROM staff WHERE id = $1 AND active`, [staffId]);
  if (!rows[0] || !verifyPin(pin, rows[0].pin_hash)) {
    await countHit(key, config.login.windowMin * 60);
    throw new HttpError(401, 'bad_credentials', 'That PIN is not right');
  }
  await resetCount(key);
  setSessionCookie(res, issueToken(rows[0]), config.sessionHours * 3600);
  const { pin_hash: _hash, session_version: _v, ...staff } = rows[0];
  return staff;
}

/** Re-issues the caller's own cookie after their session version moved (e.g. they changed their own PIN). */
export function renewSession(res, staff) {
  setSessionCookie(res, issueToken(staff), config.sessionHours * 3600);
}

export async function logout(req, res) {
  if (req.staff) {
    await pool.query(`UPDATE staff SET session_version = session_version + 1 WHERE id = $1`, [req.staff.id]);
    await invalidate(keys.staff(req.staff.id));
  }
  setSessionCookie(res, '', 0);
}