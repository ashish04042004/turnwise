import { pool } from './db.js';
import { seed } from './seed.js';

/**
 * Why a hosted demo needs a fresh synthetic day, or null if it doesn't:
 * there are no centres, the day was generated on an earlier date, or the
 * default centre has opened or closed since it was generated. Comparing
 * phases (rather than "is it closed now") re-seeds once per transition, so
 * nobody's overnight clicks are wiped every few minutes. Looks at the
 * default centre unless given one.
 */
export async function demoStaleness(centreId = null) {
  const { rows } = await pool.query(
    `WITH c AS (
       SELECT name, timezone, opens_at, closes_at - interval '30 minutes' AS winds_down,
              (SELECT max(e.created_at) FROM events e WHERE e.centre_id = centres.id AND e.type = 'centre.seeded') AS seeded_at
       FROM centres WHERE $1::uuid IS NULL OR id = $1
       ORDER BY display_order, created_at, name LIMIT 1
     )
     SELECT name, seeded_at,
            (seeded_at AT TIME ZONE timezone)::date < (now() AT TIME ZONE timezone)::date AS old_day,
            (seeded_at AT TIME ZONE timezone)::time BETWEEN opens_at AND winds_down AS seeded_open,
            (now() AT TIME ZONE timezone)::time BETWEEN opens_at AND winds_down AS open_now
     FROM c`,
    [centreId],
  );
  const c = rows[0];
  if (!c) return 'no centres yet';
  if (!c.seeded_at || c.old_day) return `${c.name} was generated on an earlier day`;
  if (c.seeded_open !== c.open_now) return c.open_now ? `${c.name} has opened since it was generated` : `${c.name} has closed since it was generated`;
  return null;
}

/** Re-seeds the demo when stale. One instance at a time; others skip. Returns what it did. */
export async function refreshDemoIfStale() {
  const lock = await pool.connect();
  try {
    const { rows } = await lock.query(`SELECT pg_try_advisory_lock(hashtext('turnwise:demo-refresh')) AS got`);
    if (!rows[0].got) return null;
    try {
      const reason = await demoStaleness();
      if (!reason) return null;
      console.log(`[demo] re-seeding: ${reason}`);
      await seed({ quiet: true });
      return reason;
    } finally {
      await lock.query(`SELECT pg_advisory_unlock(hashtext('turnwise:demo-refresh'))`);
    }
  } finally {
    lock.release();
  }
}
