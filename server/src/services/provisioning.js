import { z } from 'zod';
import { hashPin } from '../auth.js';
import { coerceSetting } from './settings.js';

const code = z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'codes are letters, digits and underscores');
const clock = z.string().regex(/^\d{2}:\d{2}$/, 'times are HH:MM');
const label = (field) => z.string().trim().min(1, `${field} is required`).max(120);

const mix = z.object({ weight: z.number().positive(), services: z.array(code).min(1) });

/** Everything that defines a centre. Fixtures, tests and the load test all build centres through this. */
export const centreSpec = z
  .object({
    name: label('name'),
    city: label('city'),
    timezone: z.string().default('Asia/Kolkata'),
    locale: z.string().default('en-IN'),
    displayOrder: z.number().int().default(0),
    hours: z.object({ opens: clock, closes: clock }),
    holdTtlSeconds: z.number().int().positive().optional(),
    offerTtlSeconds: z.number().int().positive().optional(),
    offerLeadMinutes: z.number().int().min(0).optional(),
    categories: z.array(z.object({ code, name: label('category name'), sortOrder: z.number().int().default(0) })).default([]),
    capabilities: z.array(z.object({ code, name: label('capability name') })).default([]),
    resources: z.array(z.object({ name: label('resource name'), kind: z.enum(['equipment', 'staff', 'room']), capabilities: z.array(code).min(1) })).default([]),
    services: z
      .array(z.object({ code, name: label('service name'), category: code, durationMin: z.number().int().positive(), requirements: z.array(code).min(1) }))
      .default([]),
    prerequisites: z.array(z.object({ service: code, requires: code, minGapMin: z.number().int().min(0).default(0) })).default([]),
    staff: z.array(z.object({ name: label('staff name'), role: code, pin: z.string().regex(/^\d{4,8}$/) })).default([]),
    priorityLevels: z
      .array(z.object({ level: z.number().int().min(0).max(10), label: label('priority label'), description: z.string().nullable().optional() }))
      .default([{ level: 0, label: 'Standard' }]),
    settings: z.record(z.string(), z.unknown()).default({}),
    templates: z.record(z.string(), z.string().min(1)).default({}),
    demand: z
      .object({ appointment: z.array(mix).default([]), walk_in: z.array(mix).default([]), waitlist: z.array(mix).default([]) })
      .default({ appointment: [], walk_in: [], waitlist: [] }),
  })
  .passthrough();

const titleCase = (s) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

function checkReferences(spec) {
  const services = new Set(spec.services.map((s) => s.code));
  const missing = (codes) => codes.filter((c) => !services.has(c));
  for (const p of spec.prerequisites) {
    if (missing([p.service, p.requires]).length) throw new Error(`${spec.name}: prerequisite ${p.service} → ${p.requires} names an unknown service`);
  }
  for (const [purpose, mixes] of Object.entries(spec.demand)) {
    for (const m of mixes) if (missing(m.services).length) throw new Error(`${spec.name}: ${purpose} mix names unknown services ${missing(m.services).join(', ')}`);
  }
  const capable = new Set(spec.resources.flatMap((r) => r.capabilities));
  for (const s of spec.services) {
    const unmet = s.requirements.filter((r) => !capable.has(r));
    if (unmet.length && spec.resources.length) throw new Error(`${spec.name}: no resource can provide ${unmet.join(', ')} for ${s.code}`);
  }
  if (!spec.priorityLevels.some((p) => p.level === 0)) throw new Error(`${spec.name}: priority level 0 (the default) must exist`);
}

/**
 * Creates a centre and its whole catalogue inside `db` (a transaction or the
 * pool). Categories and capabilities that services and resources use are
 * registered automatically if the spec doesn't name them. Settings are
 * validated against their definitions, so a fixture can't store a value the
 * settings screen would reject. Returns the ids needed to add activity.
 */
export async function provisionCentre(db, input) {
  const spec = centreSpec.parse(input);
  checkReferences(spec);

  const { rows: centreRows } = await db.query(
    `INSERT INTO centres (name, city, timezone, locale, display_order, opens_at, closes_at, hold_ttl_seconds, offer_ttl_seconds, offer_lead_minutes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 120), COALESCE($9, 600), COALESCE($10, 20)) RETURNING *`,
    [
      spec.name,
      spec.city,
      spec.timezone,
      spec.locale,
      spec.displayOrder,
      spec.hours.opens,
      spec.hours.closes,
      spec.holdTtlSeconds,
      spec.offerTtlSeconds,
      spec.offerLeadMinutes,
    ],
  );
  const centre = centreRows[0];
  const id = centre.id;

  const categories = new Map(spec.categories.map((c) => [c.code, c]));
  for (const s of spec.services) if (!categories.has(s.category)) categories.set(s.category, { code: s.category, name: titleCase(s.category), sortOrder: 99 });
  for (const c of categories.values()) {
    await db.query(`INSERT INTO service_categories (centre_id, code, name, sort_order) VALUES ($1, $2, $3, $4)`, [id, c.code, c.name, c.sortOrder]);
  }

  const capabilities = new Map(spec.capabilities.map((c) => [c.code, c]));
  for (const c of [...spec.resources.flatMap((r) => r.capabilities), ...spec.services.flatMap((s) => s.requirements)]) {
    if (!capabilities.has(c)) capabilities.set(c, { code: c, name: titleCase(c) });
  }
  for (const c of capabilities.values()) await db.query(`INSERT INTO capabilities (centre_id, code, name) VALUES ($1, $2, $3)`, [id, c.code, c.name]);

  const resources = [];
  for (const [i, r] of spec.resources.entries()) {
    const { rows } = await db.query(
      `INSERT INTO resources (centre_id, name, kind, capabilities, sort_order) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, kind, capabilities, active`,
      [id, r.name, r.kind, r.capabilities, i],
    );
    resources.push(rows[0]);
  }

  const services = new Map();
  for (const s of spec.services) {
    const { rows } = await db.query(
      `INSERT INTO services (centre_id, code, name, category, duration_min, requirements) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [id, s.code, s.name, s.category, s.durationMin, s.requirements],
    );
    services.set(s.code, rows[0]);
  }
  for (const p of spec.prerequisites) {
    await db.query(`INSERT INTO service_prerequisites (service_id, requires_service_id, min_gap_min) VALUES ($1, $2, $3)`, [
      services.get(p.service).id,
      services.get(p.requires).id,
      p.minGapMin,
    ]);
  }

  const staff = [];
  for (const s of spec.staff) {
    const { rows } = await db.query(`INSERT INTO staff (centre_id, name, role, pin_hash) VALUES ($1, $2, $3, $4) RETURNING id, name, role`, [
      id,
      s.name,
      s.role,
      hashPin(s.pin),
    ]);
    staff.push(rows[0]);
  }

  for (const p of spec.priorityLevels) {
    await db.query(`INSERT INTO priority_levels (centre_id, level, label, description) VALUES ($1, $2, $3, $4)`, [id, p.level, p.label, p.description ?? null]);
  }

  if (Object.keys(spec.settings).length) {
    const { rows: defs } = await db.query(`SELECT key, value_type, min_value, max_value FROM setting_definitions WHERE key = ANY($1)`, [Object.keys(spec.settings)]);
    const byKey = new Map(defs.map((d) => [d.key, { key: d.key, valueType: d.value_type, min: d.min_value == null ? null : Number(d.min_value), max: d.max_value == null ? null : Number(d.max_value) }]));
    for (const [key, value] of Object.entries(spec.settings)) {
      const def = byKey.get(key);
      if (!def) throw new Error(`${spec.name}: unknown setting ${key}`);
      await db.query(`INSERT INTO centre_settings (centre_id, key, value, updated_by) VALUES ($1, $2, $3, 'provisioning')`, [
        id,
        key,
        JSON.stringify(coerceSetting(def, value)),
      ]);
    }
  }

  for (const [key, body] of Object.entries(spec.templates)) {
    await db.query(`INSERT INTO centre_message_templates (centre_id, key, body) VALUES ($1, $2, $3)`, [id, key, body]);
  }

  for (const [purpose, mixes] of Object.entries(spec.demand)) {
    for (const m of mixes) {
      await db.query(`INSERT INTO demand_mixes (centre_id, purpose, weight, service_codes) VALUES ($1, $2, $3, $4)`, [id, purpose, m.weight, m.services]);
    }
  }

  return { centre, resources, services, staff, spec };
}

/** Adds synthetic name pools (idempotent). */
export async function loadSyntheticNames(db, { first = [], last = [] }) {
  for (const [part, values] of [['first', first], ['last', last]]) {
    if (values.length) {
      await db.query(`INSERT INTO synthetic_names (part, value) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`, [part, values]);
    }
  }
}
