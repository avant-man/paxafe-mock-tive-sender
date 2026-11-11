import { serve } from '@hono/node-server';
import { loadConfig, loadDotEnv } from './config.js';
import { createApp } from './server.js';

loadDotEnv();
const config = loadConfig();
const app = createApp({ config });

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(
    JSON.stringify({
      msg: 'mock tive sender listening',
      port: info.port,
      targetUrl: config.targetUrl,
      keyConfigured: Boolean(config.targetApiKey),
      allowOverride: config.allowOverride,
    }),
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
