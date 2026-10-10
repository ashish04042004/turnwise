import { centreKeys, invalidate, invalidateAll, invalidateLocal, keys } from './cache.js';
import { onReconnect, subscribe } from './pgListener.js';

/**
 * Keeps cached configuration honest. Reference-data triggers fire on every
 * change, including rows edited by hand in psql. Each process clears its own
 * memory and the shared Redis entries; several processes clearing the same
 * keys is harmless. (The live hub invalidates the board on every event.)
 */
export async function startCacheInvalidation() {
  onReconnect(() => invalidateLocal(() => true));
  await subscribe('turnwise_config', async ({ table, centreId, id }) => {
    if (table === 'users') return invalidate(keys.user(id));
    // Global reference data (roles, permissions, setting defaults, names) or a truncate: everything may be stale.
    if (!centreId) return invalidateAll();
    const drop = [...centreKeys(centreId), keys.centreList(), keys.defaultCentre()];
    if (table === 'staff' && id) drop.push(keys.staff(id));
    await invalidate(...drop);
  });
}
