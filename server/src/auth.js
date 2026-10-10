import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { HttpError, pool } from './db.js';

const COOKIE = 'tw_session';

/** What each role may do; viewing the board and analytics is open to every signed-in role. */
export const PERMISSIONS = {
  frontDesk: ['reception', 'manager'],
  floor: ['technician', 'manager'],
  resources: ['technician', 'manager'],
  replan: ['reception', 'manager'],
  simulate: ['manager'],
  staff: ['manager'],
};

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

/** Attaches req.staff when the session cookie is valid and its holder is still active. */
export async function authenticate(req, _res, next) {
  const claims = readToken(readCookie(req, COOKIE));
  if (claims) {
    const { rows } = await pool.query(`SELECT id, centre_id, name, role, session_version FROM staff WHERE id = $1 AND active`, [claims.s]);
    if (rows[0] && rows[0].session_version === claims.v) req.staff = rows[0];
  }
  next();
}

export function requireStaff(req, _res, next) {
  if (!req.staff) throw new HttpError(401, 'unauthenticated', 'Sign in to continue');
  next();
}

export const requireRole = (roles) => (req, _res, next) => {
  if (!req.staff) throw new HttpError(401, 'unauthenticated', 'Sign in to continue');
  if (!roles.includes(req.staff.role)) throw new HttpError(403, 'forbidden', `Only ${roles.join(' or ')} staff can do this`);
  next();
};

export const actorOf = (req) => `${req.staff.name} (${req.staff.role})`;

// Failed sign-ins per client address; PINs are short, so guessing must be slow.
const failures = new Map();
const WINDOW_MS = 10 * 60_000;
const MAX_FAILURES = 8;

function checkRate(key) {
  const entry = failures.get(key);
  if (entry && entry.resetAt > Date.now() && entry.count >= MAX_FAILURES) {
    throw new HttpError(429, 'too_many_attempts', 'Too many failed sign-ins; try again in a few minutes');
  }
}

function recordFailure(key) {
  const entry = failures.get(key);
  if (!entry || entry.resetAt <= Date.now()) failures.set(key, { count: 1, resetAt: Date.now() + WINDOW_MS });
  else entry.count++;
}

export async function login(req, res, { staffId, pin }) {
  const key = req.ip ?? 'unknown';
  checkRate(key);
  const { rows } = await pool.query(`SELECT id, centre_id, name, role, pin_hash, session_version FROM staff WHERE id = $1 AND active`, [staffId]);
  if (!rows[0] || !verifyPin(pin, rows[0].pin_hash)) {
    recordFailure(key);
    throw new HttpError(401, 'bad_credentials', 'That PIN is not right');
  }
  failures.delete(key);
  setSessionCookie(res, issueToken(rows[0]), config.sessionHours * 3600);
  const { pin_hash: _hash, session_version: _v, ...staff } = rows[0];
  return staff;
}

/** Re-issues the caller's own cookie after their session version moved (e.g. they changed their own PIN). */
export function renewSession(res, staff) {
  setSessionCookie(res, issueToken(staff), config.sessionHours * 3600);
}

export async function logout(req, res) {
  if (req.staff) await pool.query(`UPDATE staff SET session_version = session_version + 1 WHERE id = $1`, [req.staff.id]);
  setSessionCookie(res, '', 0);
}

export async function listStaff(centreId) {
  const { rows } = await pool.query(`SELECT id, name, role FROM staff WHERE centre_id = $1 AND active ORDER BY role, name`, [centreId]);
  return rows;
}
