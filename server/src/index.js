import { createApp } from './app.js';
import { config } from './config.js';
import { startLiveHub } from './live.js';

await startLiveHub();
createApp().listen(config.port, () => {
  console.log(`[api] Turnwise API listening on http://localhost:${config.port}`);
});
