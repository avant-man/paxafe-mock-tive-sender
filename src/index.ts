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
      targetAllowlist: config.targetAllowlist,
    }),
  );
});

const FORCE_EXIT_MS = 10_000;

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    console.log(JSON.stringify({ msg: 'shutting down', signal }));
    // Render waits 30 s after SIGTERM, so force exit first.
    setTimeout(() => {
      console.error(JSON.stringify({ msg: 'forced exit after timeout', timeoutMs: FORCE_EXIT_MS }));
      process.exit(1);
    }, FORCE_EXIT_MS).unref();
    server.close(() => process.exit(0));
  });
}
