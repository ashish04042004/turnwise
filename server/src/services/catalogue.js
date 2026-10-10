import { z } from 'zod';
import { centreKeys, invalidate, keys } from '../cache.js';
import { badRequest, conflict, lockCentrePlanning, notFound, pool, withTx } from '../db.js';
import { recordEvent } from '../events.js';
import { getCentre } from './reference.js';
import { displaceSteps, generateProposal } from './replan.js';

const code = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/, 'codes start with a letter and use letters, digits and underscores (up to 40)');
const label = z.string().trim().min(1, 'required').max(80);
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'times are HH:MM (24-hour)');
const order = z.number().int().min(0).max(9999);
const kind = z.enum(['equipment', 'staff', 'room']);
const prerequisites = z
  .array(z.object({ requiresServiceId: z.string().uuid(), minGapMin: z.number().int().min(0).max(1440) }))
  .max(10);

export const catalogueSchemas = {
  code,
  level: z.coerce.number().int().min(0).max(10),
  centre: z.object({ name: label, city: label, opensAt: clock, closesAt: clock }).partial().strict(),
  addCategory: z.object({ code, name: label, sortOrder: order.optional() }).strict(),
  updateCategory: z.object({ name: label, sortOrder: order }).partial().strict(),
  addCapability: z.object({ code, name: label }).strict(),
  updateCapability: z.object({ name: label }).strict(),
  addResource: z.object({ name: label, kind, capabilities: z.array(code).min(1).max(10), sortOrder: order.optional() }).strict(),
  updateResource: z.object({ name: label, kind, capabilities: z.array(code).min(1).max(10), sortOrder: order, active: z.boolean() }).partial().strict(),
  addService: z
    .object({
      code,
      name: label,
      category: code,
      durationMin: z.number().int().min(1).max(480),
      requirements: z.array(code).min(1).max(6),
      prerequisites: prerequisites.optional(),
      sortOrder: order.optional(),
    })
    .strict(),
  updateService: z
    .object({
      name: label,
      category: code,
      durationMin: z.number().int().min(1).max(480),
      requirements: z.array(code).min(1).max(6),
      prerequisites,
      sortOrder: order,
      active: z.boolean(),
    })
    .partial()
    .strict(),
  priority: z.object({ label, description: z.string().trim().max(200).nullable().optional() }).strict(),
};

const hhmm = (t) => String(t).slice(0, 5);

/** Other processes hear the reference-data triggers; this one forgets at once. */
const forget = (centreId) => invalidate(...centreKeys(centreId), keys.centreList(), keys.defaultCentre());

function translate(err, what) {
  if (err.code === '23505') return conflict(`${what} already exists`);
  if (err.code === '23514') return badRequest(`${what} is not valid (${err.constraint})`);
  return err;
}

const audit = (db, centreId, subjectId, payload, actor) => recordEvent(db, centreId, 'catalogue.changed', subjectId, payload, actor);

/** True when the resources can cover every requirement, each resource used at most once. */
export function covers(requirements, resources) {
  const used = new Set();
  const assign = (i) => {
    if (i === requirements.length) return true;
    for (const r of resources) {
      if (used.has(r.id) || !r.capabilities.includes(requirements[i])) continue;
      used.add(r.id);
      if (assign(i + 1)) return true;
      used.delete(r.id);
    }
    return false;
  };
  return assign(0);
}

/** Requirements the centre's active resources can't currently meet, e.g. "needs 2 × radiologist, has 1". */
function unmetRequirements(requirements, resources) {
  const active = resources.filter((r) => r.active);
  const needed = new Map();
  for (const c of requirements) needed.set(c, (needed.get(c) ?? 0) + 1);
  return [...needed]
    .map(([capability, count]) => ({ capability, needed: count, available: active.filter((r) => r.capabilities.includes(capability)).length }))
    .filter((u) => u.available < u.needed);
}

/** Everything a manager can edit about a centre's catalogue, with usage so the screen can explain what a change affects. */
export async function getCatalogue(centreId) {
  const q = (sql) => pool.query(sql, [centreId]).then((r) => r.rows);
  const [centres, categories, capabilities, resources, services, prereqs, priorities, upcoming] = await Promise.all([
    q(`SELECT id, name, city, timezone, opens_at, closes_at FROM centres WHERE id = $1`),
    q(`SELECT code, name, sort_order FROM service_categories WHERE centre_id = $1 ORDER BY sort_order, code`),
    q(`SELECT code, name FROM capabilities WHERE centre_id = $1 ORDER BY name`),
    q(`SELECT id, name, kind, capabilities, active, sort_order FROM resources WHERE centre_id = $1 ORDER BY sort_order, name`),
    q(`SELECT id, code, name, category, duration_min, requirements, active, sort_order FROM services WHERE centre_id = $1 ORDER BY sort_order, code`),
    q(`SELECT p.service_id, p.requires_service_id, p.min_gap_min FROM service_prerequisites p JOIN services s ON s.id = p.service_id WHERE s.centre_id = $1`),
    q(`SELECT level, label, description FROM priority_levels WHERE centre_id = $1 ORDER BY level`),
    q(
      `SELECT resource_id, count(*)::int AS n FROM reservations
       WHERE centre_id = $1 AND kind = 'service' AND status IN ('held', 'confirmed') AND upper(during) > now()
       GROUP BY resource_id`,
    ),
  ]);
  if (!centres[0]) throw notFound('Centre');
  const c = centres[0];
  const bookings = new Map(upcoming.map((u) => [u.resource_id, u.n]));
  return {
    centre: { id: c.id, name: c.name, city: c.city, timezone: c.timezone, opensAt: hhmm(c.opens_at), closesAt: hhmm(c.closes_at) },
    categories: categories.map((x) => ({ code: x.code, name: x.name, sortOrder: x.sort_order, services: services.filter((s) => s.category === x.code).length })),
    capabilities: capabilities.map((x) => ({
      code: x.code,
      name: x.name,
      resources: resources.filter((r) => r.capabilities.includes(x.code)).length,
      activeResources: resources.filter((r) => r.active && r.capabilities.includes(x.code)).length,
      services: services.filter((s) => s.requirements.includes(x.code)).length,
    })),
    resources: resources.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      capabilities: r.capabilities,
      active: r.active,
      sortOrder: r.sort_order,
      upcomingBookings: bookings.get(r.id) ?? 0,
    })),
    services: services.map((s) => ({
      id: s.id,
      code: s.code,
      name: s.name,
      category: s.category,
      durationMin: s.duration_min,
      requirements: s.requirements,
      active: s.active,
      sortOrder: s.sort_order,
      prerequisites: prereqs.filter((p) => p.service_id === s.id).map((p) => ({ requiresServiceId: p.requires_service_id, minGapMin: p.min_gap_min })),
      unmet: s.active ? unmetRequirements(s.requirements, resources) : [],
    })),
    priorityLevels: priorities,
  };
}

// Centre ----------------------------------------------------------------------

export async function updateCentre(centreId, changes, actor) {
  if (Object.keys(changes).length === 0) throw badRequest('Nothing to change');
  await withTx(async (tx) => {
    const { rows } = await tx.query(`SELECT name, city, opens_at, closes_at FROM centres WHERE id = $1 FOR UPDATE`, [centreId]);
    if (!rows[0]) throw notFound('Centre');
    const before = { name: rows[0].name, city: rows[0].city, opensAt: hhmm(rows[0].opens_at), closesAt: hhmm(rows[0].closes_at) };
    const after = { ...before, ...changes };
    if (after.opensAt >= after.closesAt) throw badRequest('Opening time must be before closing time');
    await tx.query(`UPDATE centres SET name = $2, city = $3, opens_at = $4, closes_at = $5 WHERE id = $1`, [
      centreId,
      after.name,
      after.city,
      after.opensAt,
      after.closesAt,
    ]);
    const changed = Object.keys(changes).filter((k) => changes[k] !== before[k]);
    await audit(tx, centreId, centreId, { entity: 'centre', action: 'updated', name: after.name, changed }, actor);
  });
  await forget(centreId);
  return getCatalogue(centreId);
}

// Categories ------------------------------------------------------------------

export async function addCategory(centreId, { code: c, name, sortOrder }, actor) {
  try {
    await withTx(async (tx) => {
      await tx.query(
        `INSERT INTO service_categories (centre_id, code, name, sort_order)
         VALUES ($1, $2, $3, COALESCE($4, (SELECT COALESCE(max(sort_order) + 1, 0) FROM service_categories WHERE centre_id = $1)))`,
        [centreId, c, name, sortOrder ?? null],
      );
      await audit(tx, centreId, null, { entity: 'category', action: 'added', name, code: c }, actor);
    });
  } catch (err) {
    throw translate(err, `Category "${c}"`);
  }
  await forget(centreId);
  return { code: c };
}

export async function updateCategory(centreId, categoryCode, changes, actor) {
  if (Object.keys(changes).length === 0) throw badRequest('Nothing to change');
  await withTx(async (tx) => {
    const { rows } = await tx.query(
      `UPDATE service_categories SET name = COALESCE($3, name), sort_order = COALESCE($4, sort_order)
       WHERE centre_id = $1 AND code = $2 RETURNING name`,
      [centreId, categoryCode, changes.name ?? null, changes.sortOrder ?? null],
    );
    if (!rows[0]) throw notFound('Category');
    await audit(tx, centreId, null, { entity: 'category', action: 'updated', name: rows[0].name, code: categoryCode, changed: Object.keys(changes) }, actor);
  });
  await forget(centreId);
  return { code: categoryCode };
}

export async function deleteCategory(centreId, categoryCode, actor) {
  await withTx(async (tx) => {
    const { rows: used } = await tx.query(`SELECT count(*)::int AS n FROM services WHERE centre_id = $1 AND category = $2`, [centreId, categoryCode]);
    if (used[0].n) throw conflict(`${used[0].n} service(s) are in this category; move them to another category first`);
    const { rows } = await tx.query(`DELETE FROM service_categories WHERE centre_id = $1 AND code = $2 RETURNING name`, [centreId, categoryCode]);
    if (!rows[0]) throw notFound('Category');
    await audit(tx, centreId, null, { entity: 'category', action: 'removed', name: rows[0].name, code: categoryCode }, actor);
  });
  await forget(centreId);
  return { ok: true };
}

// Capabilities ----------------------------------------------------------------

export async function addCapability(centreId, { code: c, name }, actor) {
  try {
    await withTx(async (tx) => {
      await tx.query(`INSERT INTO capabilities (centre_id, code, name) VALUES ($1, $2, $3)`, [centreId, c, name]);
      await audit(tx, centreId, null, { entity: 'capability', action: 'added', name, code: c }, actor);
    });
  } catch (err) {
    throw translate(err, `Capability "${c}"`);
  }
  await forget(centreId);
  return { code: c };
}

export async function updateCapability(centreId, capabilityCode, { name }, actor) {
  await withTx(async (tx) => {
    const { rowCount } = await tx.query(`UPDATE capabilities SET name = $3 WHERE centre_id = $1 AND code = $2`, [centreId, capabilityCode, name]);
    if (!rowCount) throw notFound('Capability');
    await audit(tx, centreId, null, { entity: 'capability', action: 'updated', name, code: capabilityCode }, actor);
  });
  await forget(centreId);
  return { code: capabilityCode };
}

export async function deleteCapability(centreId, capabilityCode, actor) {
  await withTx(async (tx) => {
    const { rows: used } = await tx.query(
      `SELECT (SELECT count(*)::int FROM resources WHERE centre_id = $1 AND $2 = ANY(capabilities)) AS resources,
              (SELECT count(*)::int FROM services WHERE centre_id = $1 AND $2 = ANY(requirements)) AS services`,
      [centreId, capabilityCode],
    );
    if (used[0].resources || used[0].services) {
      throw conflict(`Still used by ${used[0].resources} resource(s) and ${used[0].services} service(s); remove it from them first`);
    }
    const { rows } = await tx.query(`DELETE FROM capabilities WHERE centre_id = $1 AND code = $2 RETURNING name`, [centreId, capabilityCode]);
    if (!rows[0]) throw notFound('Capability');
    await audit(tx, centreId, null, { entity: 'capability', action: 'removed', name: rows[0].name, code: capabilityCode }, actor);
  });
  await forget(centreId);
  return { ok: true };
}

async function assertCapabilities(db, centreId, codes) {
  const { rows } = await db.query(`SELECT code FROM capabilities WHERE centre_id = $1 AND code = ANY($2)`, [centreId, [...new Set(codes)]]);
  const known = new Set(rows.map((r) => r.code));
  const missing = [...new Set(codes)].filter((c) => !known.has(c));
  if (missing.length) throw badRequest(`Unknown capability: ${missing.join(', ')}. Add it under Capabilities first.`);
}

// Resources -------------------------------------------------------------------

export async function addResource(centreId, { name, kind: k, capabilities, sortOrder }, actor) {
  try {
    const id = await withTx(async (tx) => {
      await assertCapabilities(tx, centreId, capabilities);
      const { rows } = await tx.query(
        `INSERT INTO resources (centre_id, name, kind, capabilities, sort_order)
         VALUES ($1, $2, $3, $4, COALESCE($5, (SELECT COALESCE(max(sort_order) + 1, 0) FROM resources WHERE centre_id = $1)))
         RETURNING id`,
        [centreId, name, k, [...new Set(capabilities)], sortOrder ?? null],
      );
      await audit(tx, centreId, rows[0].id, { entity: 'resource', action: 'added', name, capabilities }, actor);
      return rows[0].id;
    });
    await forget(centreId);
    return { id };
  } catch (err) {
    throw translate(err, `A resource named "${name}"`);
  }
}

/**
 * Edits a resource. Taking it out of service, or removing a capability that
 * upcoming bookings rely on, displaces exactly those bookings and raises a
 * re-plan proposal, as an outage would. Services already running finish.
 */
export async function updateResource(centreId, resourceId, changes, actor) {
  if (Object.keys(changes).length === 0) throw badRequest('Nothing to change');
  let result;
  try {
    result = await withTx(async (tx) => {
      await lockCentrePlanning(tx, centreId);
      const { rows } = await tx.query(`SELECT * FROM resources WHERE id = $1 AND centre_id = $2 FOR UPDATE`, [resourceId, centreId]);
      const before = rows[0];
      if (!before) throw notFound('Resource');
      if (changes.capabilities) await assertCapabilities(tx, centreId, changes.capabilities);
      const after = {
        name: changes.name ?? before.name,
        kind: changes.kind ?? before.kind,
        capabilities: changes.capabilities ? [...new Set(changes.capabilities)] : before.capabilities,
        sortOrder: changes.sortOrder ?? before.sort_order,
        active: changes.active ?? before.active,
      };
      await tx.query(`UPDATE resources SET name = $2, kind = $3, capabilities = $4, sort_order = $5, active = $6 WHERE id = $1`, [
        resourceId,
        after.name,
        after.kind,
        after.capabilities,
        after.sortOrder,
        after.active,
      ]);

      const removed = before.capabilities.filter((c) => !after.capabilities.includes(c));
      let reason = null;
      let broken = [];
      if (before.active && !after.active) {
        reason = `${after.name} taken out of service`;
        const { rows: hits } = await tx.query(
          `SELECT DISTINCT step_id FROM reservations
           WHERE resource_id = $1 AND kind = 'service' AND status IN ('held', 'confirmed') AND upper(during) > now()`,
          [resourceId],
        );
        broken = hits.map((h) => h.step_id);
      } else if (after.active && removed.length) {
        reason = `${after.name} no longer provides ${removed.join(', ')}`;
        // Re-check each upcoming booking on this resource against its whole set of reserved resources.
        const { rows: hits } = await tx.query(
          `SELECT r.step_id, sv.requirements,
                  json_agg(json_build_object('id', res.id, 'capabilities', res.capabilities)) AS resources
           FROM reservations r
           JOIN visit_steps st ON st.id = r.step_id
           JOIN services sv ON sv.id = st.service_id
           JOIN reservations mine ON mine.step_id = r.step_id AND mine.kind = 'service' AND mine.status IN ('held', 'confirmed')
           JOIN resources res ON res.id = mine.resource_id
           WHERE r.resource_id = $1 AND r.kind = 'service' AND r.status IN ('held', 'confirmed') AND upper(r.during) > now()
           GROUP BY r.step_id, sv.requirements`,
          [resourceId],
        );
        broken = hits.filter((h) => !covers(h.requirements, h.resources)).map((h) => h.step_id);
      }
      const displaced = await displaceSteps(tx, centreId, broken, reason, actor);
      const action = before.active && !after.active ? 'deactivated' : !before.active && after.active ? 'reactivated' : 'updated';
      const changed = Object.keys(changes).filter((k) => JSON.stringify(changes[k]) !== JSON.stringify(k === 'sortOrder' ? before.sort_order : before[k]));
      await audit(tx, centreId, resourceId, { entity: 'resource', action, name: after.name, changed, displaced: displaced.length }, actor);
      return { reason, displaced: displaced.length };
    });
  } catch (err) {
    throw translate(err, `A resource named "${changes.name}"`);
  }
  await forget(centreId);
  let proposalId = null;
  if (result.displaced) proposalId = (await generateProposal(await getCentre(centreId), result.reason, actor))?.id ?? null;
  return { id: resourceId, displaced: result.displaced, proposalId };
}

// Services --------------------------------------------------------------------

/** Rejects prerequisites on other centres' services, on itself, or that would form a loop. */
async function checkPrerequisites(db, centreId, serviceId, wanted) {
  if (wanted.some((p) => p.requiresServiceId === serviceId)) throw badRequest('A service cannot require itself');
  const ids = wanted.map((p) => p.requiresServiceId);
  if (new Set(ids).size !== ids.length) throw badRequest('Each prerequisite can be listed once');
  const { rows: known } = await db.query(`SELECT id FROM services WHERE centre_id = $1 AND id = ANY($2)`, [centreId, ids]);
  if (known.length !== ids.length) throw badRequest('A prerequisite is not a service at this centre');

  const { rows: edges } = await db.query(
    `SELECT p.service_id, p.requires_service_id FROM service_prerequisites p JOIN services s ON s.id = p.service_id
     WHERE s.centre_id = $1 AND p.service_id <> $2`,
    [centreId, serviceId],
  );
  const requires = new Map();
  for (const e of edges) requires.set(e.service_id, [...(requires.get(e.service_id) ?? []), e.requires_service_id]);
  requires.set(serviceId, ids);
  const seen = new Set();
  const stack = [...ids];
  while (stack.length) {
    const id = stack.pop();
    if (id === serviceId) throw badRequest('Those prerequisites would form a loop');
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(requires.get(id) ?? []));
  }
}

async function writePrerequisites(db, serviceId, wanted) {
  await db.query(`DELETE FROM service_prerequisites WHERE service_id = $1`, [serviceId]);
  for (const p of wanted) {
    await db.query(`INSERT INTO service_prerequisites (service_id, requires_service_id, min_gap_min) VALUES ($1, $2, $3)`, [
      serviceId,
      p.requiresServiceId,
      p.minGapMin,
    ]);
  }
}

async function assertCategory(db, centreId, categoryCode) {
  const { rowCount } = await db.query(`SELECT 1 FROM service_categories WHERE centre_id = $1 AND code = $2`, [centreId, categoryCode]);
  if (!rowCount) throw badRequest(`Unknown category "${categoryCode}". Add it under Categories first.`);
}

export async function addService(centreId, input, actor) {
  try {
    const id = await withTx(async (tx) => {
      await assertCategory(tx, centreId, input.category);
      await assertCapabilities(tx, centreId, input.requirements);
      const { rows } = await tx.query(
        `INSERT INTO services (centre_id, code, name, category, duration_min, requirements, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, (SELECT COALESCE(max(sort_order) + 1, 0) FROM services WHERE centre_id = $1)))
         RETURNING id`,
        [centreId, input.code, input.name, input.category, input.durationMin, input.requirements, input.sortOrder ?? null],
      );
      const serviceId = rows[0].id;
      if (input.prerequisites?.length) {
        await checkPrerequisites(tx, centreId, serviceId, input.prerequisites);
        await writePrerequisites(tx, serviceId, input.prerequisites);
      }
      await audit(tx, centreId, serviceId, { entity: 'service', action: 'added', name: input.name, code: input.code }, actor);
      return serviceId;
    });
    await forget(centreId);
    return { id };
  } catch (err) {
    throw translate(err, `Service code "${input.code}"`);
  }
}

/**
 * Edits a service. Duration and requirements apply to bookings made from now
 * on; existing bookings keep the slot and resources they were given. Retiring
 * a service stops new bookings of it without touching history.
 */
export async function updateService(centreId, serviceId, changes, actor) {
  if (Object.keys(changes).length === 0) throw badRequest('Nothing to change');
  await withTx(async (tx) => {
    const { rows } = await tx.query(`SELECT * FROM services WHERE id = $1 AND centre_id = $2 FOR UPDATE`, [serviceId, centreId]);
    const before = rows[0];
    if (!before) throw notFound('Service');
    if (changes.category) await assertCategory(tx, centreId, changes.category);
    if (changes.requirements) await assertCapabilities(tx, centreId, changes.requirements);
    await tx.query(
      `UPDATE services SET name = $2, category = $3, duration_min = $4, requirements = $5, sort_order = $6, active = $7 WHERE id = $1`,
      [
        serviceId,
        changes.name ?? before.name,
        changes.category ?? before.category,
        changes.durationMin ?? before.duration_min,
        changes.requirements ?? before.requirements,
        changes.sortOrder ?? before.sort_order,
        changes.active ?? before.active,
      ],
    );
    if (changes.prerequisites) {
      await checkPrerequisites(tx, centreId, serviceId, changes.prerequisites);
      await writePrerequisites(tx, serviceId, changes.prerequisites);
    }
    const action = changes.active === false && before.active ? 'retired' : changes.active === true && !before.active ? 'restored' : 'updated';
    await audit(tx, centreId, serviceId, { entity: 'service', action, name: changes.name ?? before.name, code: before.code, changed: Object.keys(changes) }, actor);
  });
  await forget(centreId);
  return { id: serviceId };
}

// Priority levels -------------------------------------------------------------

export async function savePriorityLevel(centreId, level, { label: l, description }, actor) {
  await withTx(async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO priority_levels (centre_id, level, label, description) VALUES ($1, $2, $3, $4)
       ON CONFLICT (centre_id, level) DO UPDATE SET label = EXCLUDED.label, description = EXCLUDED.description
       RETURNING (xmax = 0) AS inserted`,
      [centreId, level, l, description ?? null],
    );
    await audit(tx, centreId, null, { entity: 'priority', action: rows[0].inserted ? 'added' : 'updated', name: l, level }, actor);
  });
  await forget(centreId);
  return { level };
}

export async function deletePriorityLevel(centreId, level, actor) {
  if (level === 0) throw badRequest('Level 0 is the default for every visit and cannot be removed');
  await withTx(async (tx) => {
    const { rows } = await tx.query(`DELETE FROM priority_levels WHERE centre_id = $1 AND level = $2 RETURNING label`, [centreId, level]);
    if (!rows[0]) throw notFound('Priority level');
    await audit(tx, centreId, null, { entity: 'priority', action: 'removed', name: rows[0].label, level }, actor);
  });
  await forget(centreId);
  return { ok: true };
}
