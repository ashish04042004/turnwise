import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { z, ZodError } from 'zod';
import { config } from './config.js';
import { HttpError, pool } from './db.js';
import { latencyMiddleware, latencySummary } from './latency.js';
import { liveClientCount, streamHandler } from './live.js';
import { getAnalytics, getEvents } from './services/analytics.js';
import { getBoard, getPatientView } from './services/board.js';
import { confirmHold, createHold, createWalkIn, releaseVisit, searchSlots } from './services/booking.js';
import { getCentre } from './services/context.js';
import { checkIn, completeStep, extendStep, startStep } from './services/operations.js';
import { applyProposal, generateProposal, markResourceDown, markResourceUp, rejectProposal } from './services/replan.js';
import { simBreakdown, simCancel, simOverrun, simTick, simWalkInRush } from './services/simulator.js';
import { acceptOffer, addToWaitlist, declineOffer } from './services/waitlist.js';

const uuid = z.string().uuid();
const patient = z.object({ name: z.string().trim().min(2).max(80), phone: z.string().trim().max(20).optional().nullable() });
const services = z.array(uuid).min(1).max(8);

const schemas = {
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
};

const actor = (req) => req.get('x-actor')?.slice(0, 40) || 'staff';
const centre = () => getCentre(pool);

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.use(latencyMiddleware);

  const api = express.Router();

  api.get('/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true, liveClients: liveClientCount() });
  });

  api.get('/board', async (_req, res) => res.json(await getBoard()));
  api.get('/stream', streamHandler);

  api.post('/slots/search', async (req, res) => {
    const body = schemas.search.parse(req.body);
    res.json(await searchSlots(await centre(), body.serviceIds, body.from ?? null));
  });
  api.post('/bookings/hold', async (req, res) => res.status(201).json(await createHold(await centre(), schemas.hold.parse(req.body), actor(req))));
  api.post('/bookings/:id/confirm', async (req, res) => res.json(await confirmHold(await centre(), uuid.parse(req.params.id), actor(req))));
  api.post('/walk-ins', async (req, res) => res.status(201).json(await createWalkIn(await centre(), schemas.walkIn.parse(req.body), actor(req))));

  api.post('/visits/:id/check-in', async (req, res) => res.json(await checkIn(await centre(), uuid.parse(req.params.id), actor(req))));
  api.post('/visits/:id/cancel', async (req, res) => {
    const { reason } = schemas.reason.parse(req.body ?? {});
    res.json(await releaseVisit(await centre(), uuid.parse(req.params.id), 'cancelled', reason ?? null, actor(req)));
  });
  api.post('/visits/:id/no-show', async (req, res) => res.json(await releaseVisit(await centre(), uuid.parse(req.params.id), 'no_show', null, actor(req))));

  api.post('/steps/:id/start', async (req, res) => {
    const opts = schemas.start.parse(req.body ?? {});
    res.json(await startStep(await centre(), uuid.parse(req.params.id), opts, actor(req)));
  });
  api.post('/steps/:id/complete', async (req, res) => res.json(await completeStep(await centre(), uuid.parse(req.params.id), actor(req))));
  api.post('/steps/:id/extend', async (req, res) => {
    const { minutes } = schemas.extend.parse(req.body);
    res.json(await extendStep(await centre(), uuid.parse(req.params.id), minutes, actor(req)));
  });

  api.post('/resources/:id/down', async (req, res) => {
    const { minutes, reason } = schemas.down.parse(req.body);
    res.json(await markResourceDown(await centre(), uuid.parse(req.params.id), minutes, reason ?? null, actor(req)));
  });
  api.post('/resources/:id/up', async (req, res) => res.json(await markResourceUp(await centre(), uuid.parse(req.params.id), actor(req))));

  api.post('/replan', async (req, res) => res.json({ proposal: await generateProposal(await centre(), 'Requested by staff', actor(req)) }));
  api.post('/proposals/:id/apply', async (req, res) => {
    const { option } = schemas.apply.parse(req.body);
    res.json(await applyProposal(await centre(), uuid.parse(req.params.id), option, actor(req)));
  });
  api.post('/proposals/:id/reject', async (req, res) => {
    await rejectProposal(await centre(), uuid.parse(req.params.id), actor(req));
    res.json({ ok: true });
  });

  api.post('/waitlist', async (req, res) => res.status(201).json(await addToWaitlist(await centre(), schemas.waitlist.parse(req.body), actor(req))));

  api.get('/analytics', async (_req, res) => res.json(await getAnalytics()));
  api.get('/events', async (req, res) => {
    const limit = z.coerce.number().int().min(1).max(500).optional().parse(req.query.limit);
    const before = z.coerce.number().int().optional().parse(req.query.before);
    res.json(await getEvents(undefined, { limit, before }));
  });
  api.get('/metrics/latency', (_req, res) => res.json(latencySummary()));

  api.get('/public/visits/:token', async (req, res) => res.json(await getPatientView(z.string().min(6).max(64).parse(req.params.token))));
  api.post('/public/offers/:token/accept', async (req, res) => res.json(await acceptOffer(z.string().min(6).max(64).parse(req.params.token))));
  api.post('/public/offers/:token/decline', async (req, res) => res.json(await declineOffer(z.string().min(6).max(64).parse(req.params.token))));

  if (config.enableSimulator) {
    api.post('/sim/tick', async (_req, res) => res.json(await simTick()));
    api.post('/sim/walk-in-rush', async (req, res) => res.json(await simWalkInRush(undefined, schemas.rush.parse(req.body ?? {}).count ?? 3)));
    api.post('/sim/breakdown', async (req, res) => res.json(await simBreakdown(undefined, schemas.minutes.parse(req.body ?? {}).minutes ?? 30)));
    api.post('/sim/cancel', async (_req, res) => res.json(await simCancel()));
    api.post('/sim/overrun', async (req, res) => res.json(await simOverrun(undefined, schemas.minutes.parse(req.body ?? {}).minutes ?? 15)));
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
