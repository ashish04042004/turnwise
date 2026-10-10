import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { cached, countHit, invalidate, keys, peekCount, resetCount } from './cache.js';
import { config } from './config.js';
import { HttpError, pool } from './db.js';
import { getCentre, permissionsOf } from './services/reference.js';

const COOKIE = 'tw_session';
const TERMINAL_COOKIE = 'tw_terminal';

/** Salted scrypt hash for PINs and passwords. */
export function hashSecret(secret) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${scryptSync(secret, salt, 32).toString('base64')}`;
}
export const hashPin = hashSecret;

export function verifySecret(secret, stored) {
  if (!stored) return false;
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = scryptSync(String(secret), Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}
export const verifyPin = verifySecret;

const sign = (data) => createHmac('sha256', config.sessionSecret).update(data).digest('base64url');

/**
 * Signed, expiring claims. Sessions carry `s`/`v` (a staff member and their
 * session version) and, when signed in with an account, `u`/`uv` (the user
 * and theirs). Either version moving on revokes the token.
 */
export function issueToken(claims, now = Date.now(), ttlMs = config.sessionHours * 3_600_000) {
  const body = Buffer.from(JSON.stringify({ ...claims, e: now + ttlMs })).toString('base64url');
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

function setCookie(res, name, value, maxAgeSec) {
  const attrs = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (config.production) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

const sessionClaims = (user, staff) => ({
  ...(user && { u: user.id, uv: user.session_version }),
  ...(staff && { s: staff.id, v: staff.session_version }),
});

function startSession(res, user, staff) {
  setCookie(res, COOKIE, issueToken(sessionClaims(user, staff)), config.sessionHours * 3600);
}

/**
 * Who holds a session, cached because every request asks. Anything that
 * revokes a session (sign-out, PIN or password change, role change,
 * deactivation) bumps a session version and invalidates these keys; the staff
 * trigger covers edits made directly in the database.
 */
const sessionHolder = (staffId) =>
  cached(keys.staff(staffId), config.cache.staffSeconds, async () => {
    const { rows } = await pool.query(`SELECT id, centre_id, name, role, session_version, active, user_id FROM staff WHERE id = $1`, [staffId]);
    return rows[0] ?? null;
  });

const accountHolder = (userId) =>
  cached(keys.user(userId), config.cache.staffSeconds, async () => {
    const { rows } = await pool.query(`SELECT id, email, name, session_version FROM users WHERE id = $1`, [userId]);
    return rows[0] ?? null;
  });

/**
 * Attaches req.user (an account) and/or req.staff (who they are acting as at
 * a centre) when the session cookie is valid and nothing has revoked it.
 */
export async function authenticate(req, _res, next) {
  const claims = readToken(readCookie(req, COOKIE));
  if (claims) {
    let accountOk = true;
    if (claims.u) {
      const user = await accountHolder(claims.u);
      accountOk = Boolean(user && user.session_version === claims.uv);
      if (accountOk) req.user = user;
    }
    if (accountOk && claims.s) {
      const staff = await sessionHolder(claims.s);
      if (staff?.active && staff.session_version === claims.v && (!claims.u || staff.user_id === claims.u)) {
        const { active: _active, user_id: _u, ...rest } = staff;
        req.staff = rest;
      }
    }
  }
  next();
}

export function requireStaff(req, _res, next) {
  if (!req.staff) throw new HttpError(401, 'unauthenticated', 'Sign in to continue');
  next();
}

export function requireUser(req, _res, next) {
  if (!req.user) throw new HttpError(401, 'unauthenticated', 'Sign in with your account to continue');
  next();
}

/** Allows the request when the caller's role at their centre has been granted `permission`. */
export const requirePermission = (permission) => async (req, _res, next) => {
  if (!req.staff) throw new HttpError(401, 'unauthenticated', 'Sign in to continue');
  if (!(await permissionsOf(req.staff.centre_id, req.staff.role)).includes(permission)) {
    const { roles } = await getCentre(req.staff.centre_id);
    const allowed = roles.filter((r) => r.permissions.includes(permission)).map((r) => r.label);
    throw new HttpError(403, 'forbidden', allowed.length ? `Only ${allowed.join(' or ')} staff can do this` : 'Nobody here is allowed to do this');
  }
  next();
};

export const actorOf = (req) => `${req.staff.name} (${req.staff.role})`;

// Failed sign-ins per client address, counted across replicas; PINs are short, so guessing must be slow.
export const loginFailureKey = (ip) => `login-failures:${ip ?? 'unknown'}`;
export const signupKey = (ip) => `signups:${ip ?? 'unknown'}`;

async function throttled(req) {
  if ((await peekCount(loginFailureKey(req.ip))) >= config.login.maxFailures) {
    throw new HttpError(429, 'too_many_attempts', 'Too many failed sign-ins; try again in a few minutes');
  }
}
const failed = (req) => countHit(loginFailureKey(req.ip), config.login.windowMin * 60);

// Shared terminals -------------------------------------------------------------

/** The terminal this device was enrolled as, if it still is. */
export async function terminalOf(req) {
  const claims = readToken(readCookie(req, TERMINAL_COOKIE));
  if (!claims?.t) return null;
  const { rows } = await pool.query(`SELECT id, centre_id, name FROM terminals WHERE id = $1 AND revoked_at IS NULL`, [claims.t]);
  return rows[0] ?? null;
}

export function enrolDevice(res, terminal) {
  const days = config.terminalDays;
  setCookie(res, TERMINAL_COOKIE, issueToken({ t: terminal.id }, Date.now(), days * 86_400_000), days * 86_400);
}

export function forgetDevice(res) {
  setCookie(res, TERMINAL_COOKIE, '', 0);
}

/** PIN switching is open on demo centres, and elsewhere only on a terminal the centre enrolled. */
export async function assertPinAllowed(req, centre) {
  if (centre.is_demo) return;
  const terminal = await terminalOf(req);
  if (terminal?.centre_id !== centre.id) {
    throw new HttpError(403, 'not_a_terminal', 'PIN sign-in works only on this centre’s shared terminals. Sign in with your email instead.');
  }
}

// Signing in -------------------------------------------------------------------

/** Quick PIN switch between colleagues on a shared terminal (or a demo centre). */
export async function login(req, res, { staffId, pin }) {
  await throttled(req);
  const { rows } = await pool.query(`SELECT id, centre_id, name, role, pin_hash, session_version FROM staff WHERE id = $1 AND active`, [staffId]);
  if (rows[0]) await assertPinAllowed(req, await getCentre(rows[0].centre_id));
  if (!rows[0] || !verifySecret(pin, rows[0].pin_hash)) {
    await failed(req);
    throw new HttpError(401, 'bad_credentials', 'That PIN is not right');
  }
  await resetCount(loginFailureKey(req.ip));
  startSession(res, null, rows[0]);
  const { pin_hash: _hash, session_version: _v, ...staff } = rows[0];
  return staff;
}

/** Active memberships of an account, one per centre. */
export async function membershipsOf(userId) {
  const { rows } = await pool.query(
    `SELECT s.id AS "staffId", s.centre_id AS "centreId", c.name AS "centreName", c.city, s.role, r.label AS "roleLabel", s.session_version
     FROM staff s JOIN centres c ON c.id = s.centre_id
     JOIN centre_roles r ON r.centre_id = s.centre_id AND r.code = s.role
     WHERE s.user_id = $1 AND s.active
     ORDER BY c.name`,
    [userId],
  );
  return rows;
}

/** Signs a staff session in as one of the account's memberships (or none, to manage the account itself). */
export async function actAs(res, user, membership) {
  startSession(res, user, membership && { id: membership.staffId, session_version: membership.session_version });
}

/** Email and password. Lands straight in the centre when the account has exactly one. */
export async function loginWithPassword(req, res, { email, password }) {
  await throttled(req);
  const { rows } = await pool.query(`SELECT id, email, name, password_hash, session_version FROM users WHERE email = $1`, [email.trim().toLowerCase()]);
  if (!rows[0] || !verifySecret(password, rows[0].password_hash)) {
    await failed(req);
    throw new HttpError(401, 'bad_credentials', 'That email and password don’t match an account');
  }
  await resetCount(loginFailureKey(req.ip));
  const memberships = await membershipsOf(rows[0].id);
  await actAs(res, rows[0], memberships.length === 1 ? memberships[0] : null);
  return { centreId: memberships.length === 1 ? memberships[0].centreId : null };
}

/** Re-issues the caller's cookie after their own session version moved (e.g. they changed their own PIN or password). */
export function renewSession(res, { user, staff }) {
  startSession(res, user, staff);
}

/**
 * Signing out of a PIN session revokes it (shared terminals are exactly where
 * a forgotten session is dangerous). Signing out of an account only forgets
 * it on this device, unless `everywhere`, which revokes all of the account's
 * sessions and its PIN sessions too.
 */
export async function logout(req, res, { everywhere = false } = {}) {
  if (req.staff && (!req.user || everywhere)) {
    await pool.query(`UPDATE staff SET session_version = session_version + 1 WHERE id = $1`, [req.staff.id]);
    await invalidate(keys.staff(req.staff.id));
  }
  if (req.user && everywhere) {
    await pool.query(`UPDATE users SET session_version = session_version + 1 WHERE id = $1`, [req.user.id]);
    await invalidate(keys.user(req.user.id));
  }
  setCookie(res, COOKIE, '', 0);
}
