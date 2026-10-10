import { hashPin } from '../auth.js';
import { invalidate, keys } from '../cache.js';
import { badRequest, conflict, notFound, pool, withTx } from '../db.js';
import { recordEvent } from '../events.js';
import { getReference } from './reference.js';

const COLUMNS = 'id, name, role, active, created_at';

export async function listAllStaff(centreId) {
  const { rows } = await pool.query(`SELECT ${COLUMNS} FROM staff WHERE centre_id = $1 ORDER BY active DESC, role, name`, [centreId]);
  return rows;
}

/** Active staff who can sign in at a centre, for the sign-in picker. */
export async function listStaff(centreId) {
  const { rows } = await pool.query(`SELECT id, name, role FROM staff WHERE centre_id = $1 AND active ORDER BY role, name`, [centreId]);
  return rows;
}

function translate(err) {
  if (err.code === '23505') return conflict('Someone at this centre already has that name');
  if (err.code === '23503' && err.constraint === 'staff_role_fk') return badRequest('That role does not exist');
  return err;
}

export async function addStaff(centreId, { name, role, pin }, actor) {
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
 * account loses access immediately and a reset PIN can't be bypassed by an
 * old session. A centre always keeps at least one active person who can
 * manage staff, so it can never lock itself out.
 */
export async function updateStaff(centreId, staffId, changes, { actor, selfId }) {
  if (Object.keys(changes).length === 0) throw badRequest('Nothing to change');
  const { roles } = await getReference();
  const canManage = new Set(roles.filter((r) => r.permissions.includes('staff')).map((r) => r.code));
  try {
    const updated = await withTx(async (tx) => {
      // Lock the centre's staff rows so two managers can't demote each other at once.
      const { rows: everyone } = await tx.query(`SELECT id, name, role, active FROM staff WHERE centre_id = $1 ORDER BY id FOR UPDATE`, [centreId]);
      const before = everyone.find((s) => s.id === staffId);
      if (!before) throw notFound('Staff member');

      const after = { ...before, ...changes };
      if (staffId === selfId && (after.role !== before.role || !after.active)) {
        throw conflict('You cannot change your own role or deactivate yourself; ask another manager');
      }
      const managersLeft = everyone.map((s) => (s.id === staffId ? after : s)).filter((s) => s.active && canManage.has(s.role)).length;
      if (managersLeft === 0) throw conflict('The centre needs at least one active person who can manage staff');

      const { rows } = await tx.query(
        `UPDATE staff SET name = $2, role = $3, active = $4, pin_hash = COALESCE($5, pin_hash), session_version = session_version + 1
         WHERE id = $1 RETURNING ${COLUMNS}, centre_id, session_version`,
        [staffId, after.name, after.role, after.active, changes.pin ? hashPin(changes.pin) : null],
      );
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
