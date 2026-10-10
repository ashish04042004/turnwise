import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { z, ZodError } from 'zod';
import { actorOf, authenticate, login, logout, renewSession, requirePermission, requireStaff } from './auth.js';
import { config } from './config.js';
import { HttpError, pool } from './db.js';
import { latencyMiddleware, latencySummary } from './latency.js';
import { liveClientCount, streamHandler } from './live.js';
import { getAnalytics, getEvents } from './services/analytics.js';
import { getBaselineComparison } from './services/comparison.js';
import { getBoard, getPatientView } from './services/board.js';
import { confirmHold, createHold, createWalkIn, releaseVisit, searchSlots } from './services/booking.js';
import {
  addCapability,
  addCategory,
  addResource,
  addService,
  catalogueSchemas as cat,
  deleteCapability,
  deleteCategory,
  deletePriorityLevel,
  getCatalogue,
  savePriorityLevel,
  updateCapability,
  updateCategory,
  updateCentre,
  updateResource,
  updateService,
} from './services/catalogue.js';
import { checkIn, completeStep, extendStep, startStep } from './services/operations.js';
import { getCentre, getReference, listCentres, permissionsOf } from './services/reference.js';
import { applyProposal, generateProposal, markResourceDown, markResourceUp, rejectProposal } from './services/replan.js';
import { listOverrides, resetSetting, updateSetting } from './services/settings.js';
import { simBreakdown, simCancel, simOverrun, simTick, simWalkInRush } from './services/simulator.js';
import { addStaff, listAllStaff, listStaff, updateStaff } from './services/staff.js';
import { acceptOffer, addToWaitlist, declineOffer } from './services/waitlist.js';

const uuid = z.string().uuid();
const pin = z.string().regex(/^\d{4,8}$/, 'PIN must be 4–8 digits');
const staffName = z.string().trim().min(2).max(60);
// Roles live in the roles table; the foreign key rejects unknown ones.
const role = z.string().trim().min(1).max(40);
const settingKey = z.string().regex(/^[a-z][a-z0-9_]{1,59}$/);
const patient = z.object({ name: z.string().trim().min(2).max(80), phone: z.string().trim().max(20).optional().nullable() });
const services = z.array(uuid).min(1).max(8);

const schemas = {
  login: z.object({ staffId: uuid, pin }),
  addStaff: z.object({ name: staffName, role, pin }),
  updateStaff: z.object({ name: staffName.optional(), role: role.optional(), active: z.boolean().optional(), pin: pin.optional() }).strict(),
  search: z.object({ serviceIds: services, from: z.coerce.date().optional() }),
  hold: z.object({
    patient,
    serviceIds: services,
    start: z.coerce.date(),
    priority: z.number().int().min(0).max(10).optional(),
    notes: z.string().max(500).optional().nullable(),
  }),
  walkIn: z.object({
    patient,
    serviceIds: services,
    priority: z.number().int().min(0).max(10).optional(),
    notes: z.string().max(500).optional().nullable(),
  }),
  reason: z.object({ reason: z.string().max(200).optional().nullable() }),
  start: z.object({ force: z.boolean().optional() }),
  extend: z.object({ minutes: z.number().int().min(1).max(120) }),
  down: z.object({ minutes: z.number().int().min(5).max(600), reason: z.string().max(200).optional().nullable() }),
  apply: z.object({ option: z.string().min(1) }),
  waitlist: z.object({ patient, serviceIds: services, earliest: z.coerce.date(), latest: z.coerce.date() }),
  rush: z.object({ count: z.number().int().min(1).max(10).optional() }),
  minutes: z.object({ minutes: z.number().int().min(5).max(120).optional() }),
  setting: z.object({ value: z.union([z.number(), z.string(), z.boolean()]) }),
};

const token = z.string().min(6).max(64);
/** Every staff request acts on the signed-in person's own centre. */
const centreOf = (req) => getCentre(req.staff.centre_id);

/** Everything the dashboard needs to render this centre: labels, options and settings, all from the database. */
async function clientConfig(req) {
  const [centre, reference, permissions] = await Promise.all([centreOf(req), getReference(), permissionsOf(req.staff.role)]);
  const canConfigure = permissions.includes('settings');
  return {
    centre: { id: centre.id, name: centre.name, city: centre.city, timezone: centre.timezone, locale: centre.locale },
    roles: reference.roles.map(({ code, label }) => ({ code, label })),
    permissions,
    categories: centre.categories,
    capabilities: centre.capabilities,
    priorityLevels: centre.priorityLevels,
    settings: centre.settings,
    simulator: config.enableSimulator,
    ...(canConfigure && { settingDefinitions: reference.settingDefinitions, overrides: await listOverrides(centre.id) }),
  };
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(express.json({ limit: '100kb' }));
  app.use(latencyMiddleware);

  const api = express.Router();
  api.use(authenticate);

  api.get('/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true, liveClients: liveClientCount() });
  });

  // Sign-in: pick a centre, then a person at it.
  api.get('/auth/centres', async (_req, res) => res.json({ centres: await listCentres() }));
  api.get('/auth/staff', async (req, res) => {
    const centre = await getCentre(uuid.optional().parse(req.query.centreId || undefined));
    const { roles } = await getReference();
    res.json({
      centre: { id: centre.id, name: centre.name, city: centre.city },
      staff: await listStaff(centre.id),
      roles: roles.map(({ code, label }) => ({ code, label })),
      hint: centre.settings.demo_sign_in_hint || null,
      demo: config.enableSimulator,
    });
  });
  api.post('/auth/login', async (req, res) => res.json({ staff: await login(req, res, schemas.login.parse(req.body)) }));
  api.post('/auth/logout', async (req, res) => {
    await logout(req, res);
    res.json({ ok: true });
  });
  api.get('/auth/me', requireStaff, async (req, res) => {
    const { session_version: _v, ...staff } = req.staff;
    res.json({ staff, permissions: await permissionsOf(staff.role) });
  });

  // Patient-facing links, authorised by their unguessable token.
  api.get('/public/visits/:token', async (req, res) => res.json(await getPatientView(token.parse(req.params.token))));
  api.post('/public/offers/:token/accept', async (req, res) => res.json(await acceptOffer(token.parse(req.params.token))));
  api.post('/public/offers/:token/decline', async (req, res) => res.json(await declineOffer(token.parse(req.params.token))));

  // Everything below needs a signed-in staff member.
  api.use(requireStaff);

  api.get('/config', async (req, res) => res.json(await clientConfig(req)));
  api.get('/board', async (req, res) => {
    const minEventId = z.coerce.number().int().min(0).optional().parse(req.query.after);
    res.json(await getBoard(req.staff.centre_id, { minEventId }));
  });
  api.get('/stream', streamHandler);
  api.get('/analytics', async (req, res) => res.json(await getAnalytics(req.staff.centre_id)));
  api.get('/analytics/baseline', async (req, res) => res.json(await getBaselineComparison(req.staff.centre_id)));
  api.get('/events', async (req, res) => {
    const limit = z.coerce.number().int().min(1).max(500).optional().parse(req.query.limit);
    const before = z.coerce.number().int().optional().parse(req.query.before);
    res.json(await getEvents(req.staff.centre_id, { limit, before }));
  });
  api.get('/metrics/latency', (_req, res) => res.json(latencySummary()));

  const frontDesk = requirePermission('frontDesk');
  api.post('/slots/search', frontDesk, async (req, res) => {
    const body = schemas.search.parse(req.body);
    res.json(await searchSlots(await centreOf(req), body.serviceIds, body.from ?? null));
  });
  api.post('/bookings/hold', frontDesk, async (req, res) => res.status(201).json(await createHold(await centreOf(req), schemas.hold.parse(req.body), actorOf(req))));
  api.post('/bookings/:id/confirm', frontDesk, async (req, res) => res.json(await confirmHold(await centreOf(req), uuid.parse(req.params.id), actorOf(req))));
  api.post('/walk-ins', frontDesk, async (req, res) => res.status(201).json(await createWalkIn(await centreOf(req), schemas.walkIn.parse(req.body), actorOf(req))));
  api.post('/visits/:id/check-in', frontDesk, async (req, res) => res.json(await checkIn(await centreOf(req), uuid.parse(req.params.id), actorOf(req))));
  api.post('/visits/:id/cancel', frontDesk, async (req, res) => {
    const { reason } = schemas.reason.parse(req.body ?? {});
    res.json(await releaseVisit(await centreOf(req), uuid.parse(req.params.id), 'cancelled', reason ?? null, actorOf(req)));
  });
  api.post('/visits/:id/no-show', frontDesk, async (req, res) =>
    res.json(await releaseVisit(await centreOf(req), uuid.parse(req.params.id), 'no_show', null, actorOf(req))),
  );
  api.post('/waitlist', frontDesk, async (req, res) => res.status(201).json(await addToWaitlist(await centreOf(req), schemas.waitlist.parse(req.body), actorOf(req))));

  const floor = requirePermission('floor');
  api.post('/steps/:id/start', floor, async (req, res) => {
    const opts = schemas.start.parse(req.body ?? {});
    res.json(await startStep(await centreOf(req), uuid.parse(req.params.id), opts, actorOf(req)));
  });
  api.post('/steps/:id/complete', floor, async (req, res) => res.json(await completeStep(await centreOf(req), uuid.parse(req.params.id), actorOf(req))));
  api.post('/steps/:id/extend', floor, async (req, res) => {
    const { minutes } = schemas.extend.parse(req.body);
    res.json(await extendStep(await centreOf(req), uuid.parse(req.params.id), minutes, actorOf(req)));
  });

  const resourcesRole = requirePermission('resources');
  api.post('/resources/:id/down', resourcesRole, async (req, res) => {
    const { minutes, reason } = schemas.down.parse(req.body);
    res.json(await markResourceDown(await centreOf(req), uuid.parse(req.params.id), minutes, reason ?? null, actorOf(req)));
  });
  api.post('/resources/:id/up', resourcesRole, async (req, res) => res.json(await markResourceUp(await centreOf(req), uuid.parse(req.params.id), actorOf(req))));

  const replan = requirePermission('replan');
  api.post('/replan', replan, async (req, res) => res.json({ proposal: await generateProposal(await centreOf(req), 'Requested by staff', actorOf(req)) }));
  api.post('/proposals/:id/apply', replan, async (req, res) => {
    const { option } = schemas.apply.parse(req.body);
    res.json(await applyProposal(await centreOf(req), uuid.parse(req.params.id), option, actorOf(req)));
  });
  api.post('/proposals/:id/reject', replan, async (req, res) => {
    await rejectProposal(await centreOf(req), uuid.parse(req.params.id), actorOf(req));
    res.json({ ok: true });
  });

  const configure = requirePermission('settings');
  api.put('/settings/:key', configure, async (req, res) => {
    const { value } = schemas.setting.parse(req.body);
    res.json(await updateSetting(req.staff.centre_id, settingKey.parse(req.params.key), value, actorOf(req)));
  });
  api.delete('/settings/:key', configure, async (req, res) => res.json(await resetSetting(req.staff.centre_id, settingKey.parse(req.params.key), actorOf(req))));

  // Catalogue: the centre's hours, categories, capabilities, resources, services and priority levels.
  const centreId = (req) => req.staff.centre_id;
  api.get('/catalogue', configure, async (req, res) => res.json(await getCatalogue(centreId(req))));
  api.patch('/catalogue/centre', configure, async (req, res) => res.json(await updateCentre(centreId(req), cat.centre.parse(req.body), actorOf(req))));
  api.post('/catalogue/categories', configure, async (req, res) => res.status(201).json(await addCategory(centreId(req), cat.addCategory.parse(req.body), actorOf(req))));
  api.patch('/catalogue/categories/:code', configure, async (req, res) =>
    res.json(await updateCategory(centreId(req), cat.code.parse(req.params.code), cat.updateCategory.parse(req.body), actorOf(req))),
  );
  api.delete('/catalogue/categories/:code', configure, async (req, res) => res.json(await deleteCategory(centreId(req), cat.code.parse(req.params.code), actorOf(req))));
  api.post('/catalogue/capabilities', configure, async (req, res) =>
    res.status(201).json(await addCapability(centreId(req), cat.addCapability.parse(req.body), actorOf(req))),
  );
  api.patch('/catalogue/capabilities/:code', configure, async (req, res) =>
    res.json(await updateCapability(centreId(req), cat.code.parse(req.params.code), cat.updateCapability.parse(req.body), actorOf(req))),
  );
  api.delete('/catalogue/capabilities/:code', configure, async (req, res) => res.json(await deleteCapability(centreId(req), cat.code.parse(req.params.code), actorOf(req))));
  api.post('/catalogue/resources', configure, async (req, res) => res.status(201).json(await addResource(centreId(req), cat.addResource.parse(req.body), actorOf(req))));
  api.patch('/catalogue/resources/:id', configure, async (req, res) =>
    res.json(await updateResource(centreId(req), uuid.parse(req.params.id), cat.updateResource.parse(req.body), actorOf(req))),
  );
  api.post('/catalogue/services', configure, async (req, res) => res.status(201).json(await addService(centreId(req), cat.addService.parse(req.body), actorOf(req))));
  api.patch('/catalogue/services/:id', configure, async (req, res) =>
    res.json(await updateService(centreId(req), uuid.parse(req.params.id), cat.updateService.parse(req.body), actorOf(req))),
  );
  api.put('/catalogue/priority-levels/:level', configure, async (req, res) =>
    res.json(await savePriorityLevel(centreId(req), cat.level.parse(req.params.level), cat.priority.parse(req.body), actorOf(req))),
  );
  api.delete('/catalogue/priority-levels/:level', configure, async (req, res) =>
    res.json(await deletePriorityLevel(centreId(req), cat.level.parse(req.params.level), actorOf(req))),
  );

  const manageStaff = requirePermission('staff');
  api.get('/staff', manageStaff, async (req, res) => res.json({ staff: await listAllStaff(req.staff.centre_id) }));
  api.post('/staff', manageStaff, async (req, res) => res.status(201).json(await addStaff(req.staff.centre_id, schemas.addStaff.parse(req.body), actorOf(req))));
  api.patch('/staff/:id', manageStaff, async (req, res) => {
    const id = uuid.parse(req.params.id);
    const { centre_id: _c, session_version: version, ...updated } = await updateStaff(req.staff.centre_id, id, schemas.updateStaff.parse(req.body), {
      actor: actorOf(req),
      selfId: req.staff.id,
    });
    if (id === req.staff.id) renewSession(res, { id, session_version: version });
    res.json(updated);
  });

  if (config.enableSimulator) {
    const simulate = requirePermission('simulate');
    const id = (req) => req.staff.centre_id;
    api.post('/sim/tick', simulate, async (req, res) => res.json(await simTick(id(req))));
    api.post('/sim/walk-in-rush', simulate, async (req, res) => res.json(await simWalkInRush(id(req), schemas.rush.parse(req.body ?? {}).count ?? 3)));
    api.post('/sim/breakdown', simulate, async (req, res) => res.json(await simBreakdown(id(req), schemas.minutes.parse(req.body ?? {}).minutes ?? 30)));
    api.post('/sim/cancel', simulate, async (req, res) => res.json(await simCancel(id(req))));
    api.post('/sim/overrun', simulate, async (req, res) => res.json(await simOverrun(id(req), schemas.minutes.parse(req.body ?? {}).minutes ?? 15)));
  }

  app.use('/api', api);
  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'not_found', message: 'No such endpoint' } }));

  // Serve the built dashboard when present (single-process deployment).
  const webDist = fileURLToPath(new URL('../../web/dist/', import.meta.url));
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get('/{*splat}', (_req, res) => res.sendFile('index.html', { root: webDist }));
  }

  app.use((err, _req, res, _next) => {
    if (err instanceof ZodError) {
      return res.status(400).json({ error: { code: 'validation', message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') } });
    }
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'bad_json', message: 'Malformed JSON body' } });
    console.error(err);
    res.status(500).json({ error: { code: 'internal', message: 'Something went wrong' } });
  });

  return app;
}
