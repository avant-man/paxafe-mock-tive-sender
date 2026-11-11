import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { TargetError, resolveTarget, type Config, type Overrides } from './config.js';
import { buildPlan, listScenarios, UnknownScenarioError } from './generators/index.js';
import { RunHistory } from './history.js';
import { runPlan, type FetchLike, type Target } from './sender.js';

export interface AppDeps {
  config: Config;
  fetchImpl?: FetchLike;
  history?: RunHistory;
}

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
  '/favicon.svg': { file: 'favicon.svg', type: 'image/svg+xml' },
};

const IMEI = /^[0-9]{15}$/;
const startedAt = Date.now();

export function createApp({ config, fetchImpl = fetch, history = new RunHistory(200) }: AppDeps): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'");
  });

  app.onError((err, c) => {
    if (err instanceof TargetError) return c.json({ error: 'bad_target', message: err.message }, 400);
    if (err instanceof UnknownScenarioError) return c.json({ error: 'unknown_scenario', message: err.message }, 400);
    console.error(err);
    return c.json({ error: 'internal_error', message: err.message }, 500);
  });

  app.get('/health', (c) =>
    c.json({ status: 'ok', uptimeSec: Math.round((Date.now() - startedAt) / 1000), runsInMemory: history.size }),
  );

  app.get('/api/config', (c) =>
    c.json({
      targetUrl: config.targetUrl,
      keyConfigured: Boolean(config.targetApiKey),
      allowOverride: config.allowOverride,
    }),
  );

  app.get('/api/scenarios', (c) => c.json({ scenarios: listScenarios() }));

  app.post('/api/send', bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const input = await c.req.json().catch(() => null);
    if (!input || typeof input !== 'object') return c.json({ error: 'bad_request', message: 'Body must be a JSON object' }, 400);
    const { scenario, count, seed, overrides } = input as Record<string, unknown>;
    if (typeof scenario !== 'string') return c.json({ error: 'bad_request', message: 'scenario is required' }, 400);
    if (count !== undefined && (typeof count !== 'number' || !Number.isFinite(count))) {
      return c.json({ error: 'bad_request', message: 'count must be a number' }, 400);
    }
    if (seed !== undefined && seed !== null && (typeof seed !== 'number' || !Number.isInteger(seed))) {
      return c.json({ error: 'bad_request', message: 'seed must be an integer' }, 400);
    }
    const target = resolveTarget(config, readOverrides(overrides));
    const plan = buildPlan(scenario, {
      count: count as number | undefined,
      seed: typeof seed === 'number' ? seed : undefined,
    });
    const run = await runPlan(plan, target, {
      fetchImpl,
      timeoutMs: config.requestTimeoutMs,
      count: typeof count === 'number' ? count : undefined,
    });
    history.add(run);
    return c.json(run);
  });

  app.get('/api/history', (c) => c.json({ runs: history.list() }));

  app.get('/api/history/:id', (c) => {
    const run = history.get(c.req.param('id'));
    return run ? c.json(run) : c.json({ error: 'not_found' }, 404);
  });

  app.delete('/api/history', (c) => {
    history.clear();
    return c.body(null, 204);
  });

  app.get('/api/verify/:imei', async (c) => {
    const imei = c.req.param('imei');
    if (!IMEI.test(imei)) return c.json({ error: 'bad_request', message: 'IMEI must be 15 digits' }, 400);
    const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 20) || 20));
    const target = resolveTarget(config, headerOverrides(c));
    return proxyGet(c, target, `/api/devices/${imei}/readings?limit=${limit}`, fetchImpl, config.requestTimeoutMs);
  });

  app.get('/api/target/health', async (c) => {
    const target = resolveTarget(config, headerOverrides(c));
    return proxyGet(c, target, '/health', fetchImpl, config.requestTimeoutMs);
  });

  const files = loadStatic();
  for (const [route, f] of Object.entries(STATIC_FILES)) {
    const content = files.get(f.file);
    if (content === undefined) continue;
    app.get(route, (c) => {
      c.header('Content-Type', f.type);
      c.header('Cache-Control', 'no-cache');
      return c.body(content);
    });
  }

  return app;
}

function loadStatic(): Map<string, string> {
  const out = new Map<string, string>();
  for (const { file } of Object.values(STATIC_FILES)) {
    try {
      out.set(file, readFileSync(PUBLIC_DIR + file, 'utf8'));
    } catch {
      // A missing optional file (for example the favicon) just is not served.
    }
  }
  return out;
}

function readOverrides(raw: unknown): Overrides {
  if (!raw || typeof raw !== 'object') return {};
  const o = raw as Record<string, unknown>;
  return {
    targetUrl: typeof o['targetUrl'] === 'string' ? o['targetUrl'] : undefined,
    apiKey: typeof o['apiKey'] === 'string' ? o['apiKey'] : undefined,
  };
}

function headerOverrides(c: Context): Overrides {
  return { targetUrl: c.req.header('X-Target-Url'), apiKey: c.req.header('X-Target-Key') };
}

async function proxyGet(c: Context, target: Target, path: string, fetchImpl: FetchLike, timeoutMs: number) {
  const url = `${target.url}${path}`;
  const t0 = performance.now();
  try {
    const res = await fetchImpl(url, {
      headers: target.apiKey ? { 'X-API-Key': target.apiKey } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Keep the raw text.
    }
    return c.json({ url, httpStatus: res.status, latencyMs: Math.round(performance.now() - t0), body });
  } catch (err) {
    return c.json(
      { url, httpStatus: 0, latencyMs: Math.round(performance.now() - t0), error: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
}
