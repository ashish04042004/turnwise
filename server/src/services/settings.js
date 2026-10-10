import { centreKeys, invalidate } from '../cache.js';
import { badRequest, notFound, pool, withTx } from '../db.js';
import { recordEvent } from '../events.js';
import { getReference } from './reference.js';

/** Checks a value against its definition's type and bounds, returning it in canonical form. */
export function coerceSetting(def, value) {
  switch (def.valueType) {
    case 'integer':
    case 'number': {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isFinite(n)) throw badRequest(`${def.key} must be a number`);
      if (def.valueType === 'integer' && !Number.isInteger(n)) throw badRequest(`${def.key} must be a whole number`);
      if (def.min != null && n < def.min) throw badRequest(`${def.key} must be at least ${def.min}`);
      if (def.max != null && n > def.max) throw badRequest(`${def.key} must be at most ${def.max}`);
      return n;
    }
    case 'boolean':
      if (typeof value !== 'boolean') throw badRequest(`${def.key} must be true or false`);
      return value;
    case 'text':
      if (typeof value !== 'string' || value.length > 500) throw badRequest(`${def.key} must be text (up to 500 characters)`);
      return value.trim();
    default:
      throw badRequest(`${def.key} has an unknown type`);
  }
}

async function definition(key) {
  const def = (await getReference()).settingDefinitions.find((d) => d.key === key);
  if (!def) throw notFound(`Setting ${key}`);
  return def;
}

/** Overrides one setting for a centre. Other processes hear the trigger; this one invalidates at once. */
export async function updateSetting(centreId, key, value, actor) {
  const def = await definition(key);
  const coerced = coerceSetting(def, value);
  await withTx(async (tx) => {
    const { rows } = await tx.query(`SELECT value FROM centre_settings WHERE centre_id = $1 AND key = $2 FOR UPDATE`, [centreId, key]);
    const from = rows[0]?.value ?? def.defaultValue;
    await tx.query(
      `INSERT INTO centre_settings (centre_id, key, value, updated_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (centre_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [centreId, key, JSON.stringify(coerced), actor],
    );
    await recordEvent(tx, centreId, 'settings.changed', null, { key, from, to: coerced }, actor);
  });
  await invalidate(...centreKeys(centreId));
  return { key, value: coerced, overridden: true };
}

/** Removes a centre's override so the definition's default applies again. */
export async function resetSetting(centreId, key, actor) {
  const def = await definition(key);
  await withTx(async (tx) => {
    const { rows } = await tx.query(`DELETE FROM centre_settings WHERE centre_id = $1 AND key = $2 RETURNING value`, [centreId, key]);
    if (rows[0]) await recordEvent(tx, centreId, 'settings.changed', null, { key, from: rows[0].value, to: def.defaultValue, reset: true }, actor);
  });
  await invalidate(...centreKeys(centreId));
  return { key, value: def.defaultValue, overridden: false };
}

/** Which settings a centre has overridden, for the settings screen. */
export async function listOverrides(centreId) {
  const { rows } = await pool.query(`SELECT key, updated_at, updated_by FROM centre_settings WHERE centre_id = $1`, [centreId]);
  return rows;
}
