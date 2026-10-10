import pg from 'pg';
import { config } from './config.js';

/**
 * One dedicated connection per process for Postgres LISTEN, shared by every
 * subscriber, reconnecting on failure. Notifications are only delivered for
 * committed transactions.
 */
const handlers = new Map();
const reconnectHandlers = new Set();
let client = null;
let ready = null;
let connectedBefore = false;

/** Notifications sent while the connection was down are lost; `fn` runs after each reconnect so callers can resync. */
export const onReconnect = (fn) => reconnectHandlers.add(fn);

const listen = (c, channel) => c.query(`LISTEN ${pg.escapeIdentifier(channel)}`);

/** Calls `handler(payload)` for every notification on `channel`; resolves once listening. */
export async function subscribe(channel, handler) {
  const isNew = !handlers.has(channel);
  if (isNew) handlers.set(channel, new Set());
  handlers.get(channel).add(handler);
  if (!ready) ready = new Promise((resolve) => connect(resolve));
  await ready;
  if (isNew && client) await listen(client, channel);
}

function dispatch(msg) {
  let payload;
  try {
    payload = JSON.parse(msg.payload);
  } catch (err) {
    console.error(`[listen] bad payload on ${msg.channel}`, err.message);
    return;
  }
  for (const h of handlers.get(msg.channel) ?? []) {
    Promise.resolve()
      .then(() => h(payload))
      .catch((err) => console.error(`[listen] ${msg.channel} handler failed`, err));
  }
}

async function connect(onReady) {
  const c = new pg.Client({ connectionString: config.databaseUrl });
  const retry = (err) => {
    console.error('[listen] connection lost, reconnecting', err.message);
    if (client === c) client = null;
    c.end().catch(() => undefined);
    setTimeout(() => connect(onReady), 2000);
  };
  c.on('error', retry);
  c.on('notification', dispatch);
  try {
    await c.connect();
    for (const channel of handlers.keys()) await listen(c, channel);
    client = c;
    if (connectedBefore) for (const fn of reconnectHandlers) Promise.resolve().then(fn).catch((err) => console.error('[listen] resync failed', err));
    connectedBefore = true;
    onReady();
  } catch (err) {
    retry(err);
  }
}
