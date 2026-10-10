import { createApp } from './app.js';
import { config } from './config.js';
import { startCacheInvalidation } from './invalidation.js';
import { startLiveHub } from './live.js';

await Promise.all([startLiveHub(), startCacheInvalidation()]);
createApp().listen(config.port, () => {
  console.log(`[api] Turnwise API listening on http://localhost:${config.port}`);
});
