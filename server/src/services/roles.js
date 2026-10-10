import { z } from 'zod';
import { centreKeys, invalidate } from '../cache.js';
import { badRequest, conflict, HttpError, notFound, pool, withTx } from '../db.js';
import { recordEvent } from '../events.js';
import { getCentre, getReference } from './reference.js';

const label = z.string().trim().min(1, 'required').max(60);
const description = z.string().trim().max(200).nullable();
const permissions = z.array(z.string().min(1)).max(50);

const code = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9_]{0,39}$/, 'role codes start with a letter and use lowercase letters, digits and underscores');

export const roleSchemas = {
  code,
  add: z
    .object({
      code,
      label,
      description: description.optional(),
      permissions,
    })
    .strict(),
  update: z.object({ label, description, permissions, sortOrder: z.number().int().min(0).max(9999) }).partial().strict(),
};

const forget = (centreId) => invalidate(...centreKeys(centreId));

/** Every permission there is, with what it allows, for the role editor. */
export async function listPermissions() {
  return (await getReference()).permissions;
}

export async function listRoles(centreId) {
  const [{ roles }, counts, all] = await Promise.all([
    getCentre(centreId),
    pool.query(`SELECT role, count(*) FILTER (WHERE active)::int AS active, count(*)::int AS total FROM staff WHERE centre_id = $1 GROUP BY role`, [centreId]),
    listPermissions(),
  ]);
  const byRole = new Map(counts.rows.map((r) => [r.role, r]));
  return {
    permissions: all,
    roles: roles.map((r) => ({ ...r, activeStaff: byRole.get(r.code)?.active ?? 0, totalStaff: byRole.get(r.code)?.total ?? 0 })),
  };
}

/**
 * A centre must always keep someone active who can manage roles and someone
 * who can manage staff; otherwise nobody could ever fix its access again.
 * Call inside the transaction that made the change, after making it.
 */
export async function assertCentreGoverned(tx, centreId) {
  const { rows } = await tx.query(
    `SELECT coalesce(bool_or(p.permission_code = 'roles'), false) AS roles, coalesce(bool_or(p.permission_code = 'staff'), false) AS staff
     FROM staff s JOIN centre_role_permissions p ON p.centre_id = s.centre_id AND p.role_code = s.role
     WHERE s.centre_id = $1 AND s.active`,
    [centreId],
  );
  if (!rows[0].roles) throw conflict('Someone active at the centre must still be able to manage roles');
  if (!rows[0].staff) throw conflict('Someone active at the centre must still be able to manage staff');
}

/** Serializes access changes at a centre so two managers can't strip each other's access at once. */
export const lockCentreAccess = (tx, centreId) => tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`access:${centreId}`]);

/**
 * People who can manage staff but not roles may only hand out roles whose
 * permissions they hold themselves, so nobody can promote someone (or a
 * friend) above their own level.
 */
export async function assertCanGrant(centreId, actorRole, role) {
  const { roles } = await getCentre(centreId);
  const target = roles.find((r) => r.code === role);
  if (!target) throw badRequest('That role does not exist at this centre');
  const mine = new Set(roles.find((r) => r.code === actorRole)?.permissions ?? []);
  if (mine.has('roles')) return;
  const beyond = target.permissions.filter((p) => !mine.has(p));
  if (beyond.length) {
    throw new HttpError(403, 'forbidden', `The ${target.label} role can do things you can't (${beyond.join(', ')}); ask someone who manages roles`);
  }
}

async function checkPermissions(codes) {
  const known = new Set((await listPermissions()).map((p) => p.code));
  const unknown = codes.filter((c) => !known.has(c));
  if (unknown.length) throw badRequest(`Unknown permissions: ${unknown.join(', ')}`);
  return [...new Set(codes)];
}

async function setPermissions(tx, centreId, code, codes) {
  await tx.query(`DELETE FROM centre_role_permissions WHERE centre_id = $1 AND role_code = $2`, [centreId, code]);
  if (codes.length) {
    await tx.query(`INSERT INTO centre_role_permissions (centre_id, role_code, permission_code) SELECT $1, $2, unnest($3::text[])`, [centreId, code, codes]);
  }
}

export async function addRole(centreId, input, actor) {
  const codes = await checkPermissions(input.permissions);
  try {
    await withTx(async (tx) => {
      const { rows } = await tx.query(`SELECT coalesce(max(sort_order), 0) + 1 AS next FROM centre_roles WHERE centre_id = $1`, [centreId]);
      await tx.query(`INSERT INTO centre_roles (centre_id, code, label, description, sort_order) VALUES ($1, $2, $3, $4, $5)`, [
        centreId,
        input.code,
        input.label,
        input.description ?? null,
        rows[0].next,
      ]);
      await setPermissions(tx, centreId, input.code, codes);
      await recordEvent(tx, centreId, 'roles.changed', null, { action: 'added', role: input.code, label: input.label, permissions: codes }, actor);
    });
  } catch (err) {
    if (err.code === '23505') throw conflict('A role with that code already exists');
    throw err;
  }
  await forget(centreId);
  return (await listRoles(centreId)).roles.find((r) => r.code === input.code);
}

export async function updateRole(centreId, code, changes, actor) {
  if (Object.keys(changes).length === 0) throw badRequest('Nothing to change');
  const codes = changes.permissions && (await checkPermissions(changes.permissions));
  await withTx(async (tx) => {
    await lockCentreAccess(tx, centreId);
    const { rows } = await tx.query(`SELECT label, description, sort_order FROM centre_roles WHERE centre_id = $1 AND code = $2 FOR UPDATE`, [centreId, code]);
    if (!rows[0]) throw notFound('Role');
    await tx.query(`UPDATE centre_roles SET label = $3, description = $4, sort_order = $5 WHERE centre_id = $1 AND code = $2`, [
      centreId,
      code,
      changes.label ?? rows[0].label,
      changes.description === undefined ? rows[0].description : changes.description,
      changes.sortOrder ?? rows[0].sort_order,
    ]);
    if (codes) await setPermissions(tx, centreId, code, codes);
    await assertCentreGoverned(tx, centreId);
    await recordEvent(tx, centreId, 'roles.changed', null, { action: 'updated', role: code, label: changes.label ?? rows[0].label, permissions: codes }, actor);
  });
  await forget(centreId);
  return (await listRoles(centreId)).roles.find((r) => r.code === code);
}

export async function deleteRole(centreId, code, actor) {
  await withTx(async (tx) => {
    await lockCentreAccess(tx, centreId);
    const { rows: holders } = await tx.query(`SELECT count(*)::int AS n FROM staff WHERE centre_id = $1 AND role = $2`, [centreId, code]);
    if (holders[0].n) throw conflict(`${holders[0].n} staff ${holders[0].n === 1 ? 'has' : 'have'} this role; give them another role first`);
    const { rows } = await tx.query(`DELETE FROM centre_roles WHERE centre_id = $1 AND code = $2 RETURNING label`, [centreId, code]);
    if (!rows[0]) throw notFound('Role');
    await recordEvent(tx, centreId, 'roles.changed', null, { action: 'deleted', role: code, label: rows[0].label }, actor);
  });
  await forget(centreId);
}
