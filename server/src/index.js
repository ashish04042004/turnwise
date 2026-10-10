import { createApp } from './app.js';
import { config } from './config.js';
import { refreshDemoIfStale } from './demo.js';
import { startCacheInvalidation } from './invalidation.js';
import { startLiveHub } from './live.js';
import { migrate } from './migrate.js';

if (config.migrateOnStart) {
  const ran = await migrate();
  if (ran.length) console.log(`[api] applied migrations: ${ran.join(', ')}`);
}
if (config.demoAutoRefresh) await refreshDemoIfStale();

await Promise.all([startLiveHub(), startCacheInvalidation()]);
createApp().listen(config.port, () => {
  console.log(`[api] Turnwise API listening on http://localhost:${config.port}`);
});

if (config.workerInApi) await import('./worker.js');
