import { hashPin } from '../auth.js';
import { invalidate, keys } from '../cache.js';
import { badRequest, conflict, notFound, pool, withTx } from '../db.js';
import { recordEvent } from '../events.js';
import { assertCanGrant, assertCentreGoverned, lockCentreAccess } from './roles.js';

const COLUMNS = 'id, name, role, active, created_at';

export async function listAllStaff(centreId) {
  const { rows } = await pool.query(
    `SELECT s.id, s.name, s.role, s.active, s.created_at, u.email, s.pin_hash IS NOT NULL AS "hasPin"
     FROM staff s LEFT JOIN users u ON u.id = s.user_id
     WHERE s.centre_id = $1 ORDER BY s.active DESC, s.role, s.name`,
    [centreId],
  );
  return rows;
}

/** Active staff who can sign in with a PIN at a centre, for the sign-in picker. */
export async function listStaff(centreId) {
  const { rows } = await pool.query(`SELECT id, name, role FROM staff WHERE centre_id = $1 AND active AND pin_hash IS NOT NULL ORDER BY role, name`, [
    centreId,
  ]);
  return rows;
}

function translate(err) {
  if (err.code === '23505') return conflict('Someone at this centre already has that name');
  if (err.code === '23503' && err.constraint === 'staff_centre_role_fk') return badRequest('That role does not exist');
  return err;
}

export async function addStaff(centreId, { name, role, pin }, { actor, actorRole }) {
  await assertCanGrant(centreId, actorRole, role);
  try {
    return await withTx(async (tx) => {
      const { rows } = await tx.query(`INSERT INTO staff (centre_id, name, role, pin_hash) VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`, [
        centreId,
        name,
        role,
        hashPin(pin),
      ]);
      await recordEvent(tx, centreId, 'staff.added', rows[0].id, { name, role }, actor);
      return rows[0];
    });
  } catch (err) {
    throw translate(err);
  }
}

/**
 * Changes role, active status, name or PIN. Any change signs the person out
 * everywhere (their session version moves on), so a demoted or deactivated
 * person loses access immediately and a reset PIN can't be bypassed by an
 * old session. A centre always keeps someone active who can manage staff and
 * roles, so it can never lock itself out.
 */
export async function updateStaff(centreId, staffId, changes, { actor, actorRole, selfId }) {
  if (Object.keys(changes).length === 0) throw badRequest('Nothing to change');
  if (changes.role) await assertCanGrant(centreId, actorRole, changes.role);
  try {
    const updated = await withTx(async (tx) => {
      await lockCentreAccess(tx, centreId);
      const { rows: found } = await tx.query(`SELECT id, name, role, active FROM staff WHERE centre_id = $1 AND id = $2 FOR UPDATE`, [centreId, staffId]);
      const before = found[0];
      if (!before) throw notFound('Staff member');
      // Demoting or removing someone above your level is as much an escalation as promoting.
      if (staffId !== selfId && (changes.role !== undefined || changes.active !== undefined)) await assertCanGrant(centreId, actorRole, before.role);

      const after = { ...before, ...changes };
      if (staffId === selfId && (after.role !== before.role || !after.active)) {
        throw conflict('You cannot change your own role or deactivate yourself; ask another manager');
      }

      const { rows } = await tx.query(
        `UPDATE staff SET name = $2, role = $3, active = $4, pin_hash = COALESCE($5, pin_hash), session_version = session_version + 1
         WHERE id = $1 RETURNING ${COLUMNS}, centre_id, session_version`,
        [staffId, after.name, after.role, after.active, changes.pin ? hashPin(changes.pin) : null],
      );
      await assertCentreGoverned(tx, centreId);
      const changed = Object.keys(changes).filter((k) => k === 'pin' || changes[k] !== before[k]);
      await recordEvent(
        tx,
        centreId,
        'staff.updated',
        staffId,
        { name: after.name, changed, role: changed.includes('role') ? after.role : undefined, active: changed.includes('active') ? after.active : undefined },
        actor,
      );
      return rows[0];
    });
    await invalidate(keys.staff(staffId));
    return updated;
  } catch (err) {
    throw translate(err);
  }
}
