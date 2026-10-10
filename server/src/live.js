import { invalidate, keys } from './cache.js';
import { pool } from './db.js';
import { subscribe } from './pgListener.js';
import { getCentre } from './services/context.js';

const clients = new Set();
const REPLAY_LIMIT = 1000;

const write = (res, evt) => res.write(`id: ${evt.id}\ndata: ${JSON.stringify(evt)}\n\n`);

function broadcast(evt) {
  for (const c of clients) {
    if (c.centreId !== evt.centreId) continue;
    if (!c.ready) c.buffer.push(evt);
    else if (evt.id > c.lastId) {
      c.lastId = evt.id;
      write(c.res, evt);
    }
  }
}

/**
 * Forwards committed events to SSE clients, so dashboards never see a change
 * that was rolled back. The cached board is dropped first, so the refresh an
 * event triggers can't be served the board from before it.
 */
export async function startLiveHub() {
  await subscribe('turnwise_events', async (evt) => {
    await invalidate(keys.board(evt.centreId));
    broadcast(evt);
  });
}

/**
 * Server-Sent Events stream. A reconnecting client sends Last-Event-ID and
 * receives every event it missed from the audit log before live ones resume.
 */
export async function streamHandler(req, res) {
  const centre = await getCentre(req.staff?.centre_id);
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 2000\n\n');

  const lastId = Number(req.get('Last-Event-ID') ?? req.query.lastEventId ?? 0) || 0;
  const client = { res, centreId: centre.id, ready: false, buffer: [], lastId };
  clients.add(client);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(client);
  });

  if (lastId > 0) {
    const { rows } = await pool.query(
      `SELECT id, centre_id AS "centreId", type, subject_id AS "subjectId" FROM events
       WHERE centre_id = $1 AND id > $2 ORDER BY id LIMIT $3`,
      [centre.id, lastId, REPLAY_LIMIT],
    );
    if (rows.length === REPLAY_LIMIT) {
      res.write(`event: reset\ndata: {}\n\n`);
    } else {
      for (const evt of rows) write(res, evt);
    }
    if (rows.length) client.lastId = rows.at(-1).id;
  }
  for (const evt of client.buffer) {
    if (evt.id > client.lastId) {
      client.lastId = evt.id;
      write(res, evt);
    }
  }
  client.buffer = [];
  client.ready = true;
}

export const liveClientCount = () => clients.size;
