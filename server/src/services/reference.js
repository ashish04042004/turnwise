import { cached, invalidate, keys } from '../cache.js';
import { config } from '../config.js';
import { notFound, pool } from '../db.js';

const ttl = () => config.cache.configSeconds;
const CENTRE_ORDER = 'display_order, created_at, name';
const num = (x) => (x == null ? null : Number(x));

/** Global reference data: role templates for new centres, permissions, setting definitions, synthetic name pools. */
export function getReference() {
  return cached(keys.reference(), ttl(), async () => {
    const [roles, permissions, grants, definitions, names] = await Promise.all([
      pool.query('SELECT code, label, sort_order FROM roles ORDER BY sort_order, code'),
      pool.query('SELECT code, description FROM permissions ORDER BY code'),
      pool.query('SELECT role_code, permission_code FROM role_permissions'),
      pool.query('SELECT * FROM setting_definitions ORDER BY category, key'),
      pool.query('SELECT part, value FROM synthetic_names ORDER BY value'),
    ]);
    return {
      roles: roles.rows.map((r) => ({
        code: r.code,
        label: r.label,
        sortOrder: r.sort_order,
        permissions: grants.rows.filter((g) => g.role_code === r.code).map((g) => g.permission_code),
      })),
      permissions: permissions.rows,
      settingDefinitions: definitions.rows.map((d) => ({
        key: d.key,
        description: d.description,
        valueType: d.value_type,
        defaultValue: d.default_value,
        min: num(d.min_value),
        max: num(d.max_value),
        category: d.category,
      })),
      syntheticNames: {
        first: names.rows.filter((n) => n.part === 'first').map((n) => n.value),
        last: names.rows.filter((n) => n.part === 'last').map((n) => n.value),
      },
    };
  });
}

/** What a role at a centre may do. Each centre edits its own roles. */
export async function permissionsOf(centreId, role) {
  return (await getCentre(centreId)).roles.find((r) => r.code === role)?.permissions ?? [];
}

/** Every setting with the centre's override applied over the definition's default. */
export function resolveSettings(definitions, overrides) {
  const byKey = new Map(overrides.map((o) => [o.key, o.value]));
  return Object.fromEntries(definitions.map((d) => [d.key, byKey.has(d.key) ? byKey.get(d.key) : d.defaultValue]));
}

async function loadCentre(centreId) {
  const { rows } = await pool.query('SELECT * FROM centres WHERE id = $1', [centreId]);
  if (!rows[0]) throw notFound('Centre');
  const q = (sql) => pool.query(sql, [centreId]).then((r) => r.rows);
  const [reference, overrides, categories, capabilities, priorityLevels, templates, mixes, roles] = await Promise.all([
    getReference(),
    q('SELECT key, value FROM centre_settings WHERE centre_id = $1'),
    q('SELECT code, name, sort_order FROM service_categories WHERE centre_id = $1 ORDER BY sort_order, code'),
    q('SELECT code, name FROM capabilities WHERE centre_id = $1 ORDER BY name'),
    q('SELECT level, label, description FROM priority_levels WHERE centre_id = $1 ORDER BY level'),
    q(
      `SELECT t.key, COALESCE(c.body, t.body) AS body FROM message_templates t
       LEFT JOIN centre_message_templates c ON c.key = t.key AND c.channel = t.channel AND c.centre_id = $1
       WHERE t.channel = 'sms'`,
    ),
    q('SELECT purpose, weight, service_codes FROM demand_mixes WHERE centre_id = $1 ORDER BY id'),
    q(
      `SELECT r.code, r.label, r.description, r.sort_order,
              COALESCE(array_agg(p.permission_code ORDER BY p.permission_code) FILTER (WHERE p.permission_code IS NOT NULL), '{}') AS permissions
       FROM centre_roles r
       LEFT JOIN centre_role_permissions p ON p.centre_id = r.centre_id AND p.role_code = r.code
       WHERE r.centre_id = $1
       GROUP BY r.code, r.label, r.description, r.sort_order
       ORDER BY r.sort_order, r.code`,
    ),
  ]);
  const demand = { appointment: [], walk_in: [], waitlist: [] };
  for (const m of mixes) demand[m.purpose].push({ weight: Number(m.weight), services: m.service_codes });
  return {
    ...rows[0],
    settings: resolveSettings(reference.settingDefinitions, overrides),
    categories: categories.map((c) => ({ code: c.code, name: c.name, sortOrder: c.sort_order })),
    capabilities,
    priorityLevels: priorityLevels.length ? priorityLevels : [{ level: 0, label: 'Standard', description: null }],
    templates: Object.fromEntries(templates.map((t) => [t.key, t.body])),
    demand,
    roles: roles.map((r) => ({ code: r.code, label: r.label, description: r.description, sortOrder: r.sort_order, permissions: r.permissions })),
  };
}

async function defaultCentreId() {
  const id = await cached(
    keys.defaultCentre(),
    ttl(),
    async () => (await pool.query(`SELECT id FROM centres ORDER BY is_demo DESC, ${CENTRE_ORDER} LIMIT 1`)).rows[0]?.id ?? null,
  );
  if (!id) throw notFound('Centre (run `npm run seed`)');
  return id;
}

/**
 * A centre with everything configurable about it: settings, categories,
 * capabilities, priority levels, message templates and demand mixes.
 * Cached and shared; treat it as read-only.
 */
export async function getCentre(centreId) {
  if (centreId) return cached(keys.centre(centreId), ttl(), () => loadCentre(centreId));
  const id = await defaultCentreId();
  try {
    return await getCentre(id);
  } catch (err) {
    // The default centre was deleted (e.g. re-seeded) before invalidation reached this process.
    if (err.status !== 404) throw err;
    await invalidate(keys.defaultCentre());
    return getCentre(await defaultCentreId());
  }
}

/** Demo centres, for the public sign-in screen. Other centres are private to their members. */
export function listCentres() {
  return cached(keys.centreList(), ttl(), async () => (await pool.query(`SELECT id, name, city FROM centres WHERE is_demo ORDER BY ${CENTRE_ORDER}`)).rows);
}
