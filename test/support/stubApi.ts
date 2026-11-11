/**
 * A tiny in-memory stand-in for the Integration API, following the response contract
 * in DESIGN-SPEC.md. Used by the server tests and as a local fallback target:
 *   npx tsx test/support/stubApi.ts   (port 3000, key test-key-local)
 */
import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';

type Issue = { code: string; path: string; message: string };
type Item = Record<string, unknown>;

const SENTINELS = new Set([327.67, -327.68, 32767, -32768, -3276.8, 3276.7]);

/**
 * `accountId` makes the key scoped to one account, like `npm run create-key -- name 478`
 * in the API: a payload with another AccountId gets 422 ACCOUNT_MISMATCH.
 */
export function createStubApi(apiKey = 'test-key-local', opts: { accountId?: number } = {}): Hono {
  const app = new Hono();
  const stored = new Map<string, { hash: string; payload: Item }>();

  app.get('/health', (c) => c.json({ status: 'ok', db: 'stub' }));

  app.use('/api/*', async (c, next) => {
    const key = c.req.header('X-API-Key') ?? c.req.header('Authorization')?.replace(/^Bearer\s+/i, '');
    if (key !== apiKey) return c.json({ error: 'unauthorized' }, 401);
    await next();
  });

  app.post('/api/webhook/tive', async (c) => {
    if (!(c.req.header('Content-Type') ?? '').includes('application/json')) return c.json({ error: 'unsupported_media_type' }, 415);
    const text = await c.req.text();
    if (Buffer.byteLength(text) > 1024 * 1024) return c.json({ error: 'payload_too_large' }, 413);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    if (Array.isArray(body)) {
      if (body.length === 0 || body.length > 100) return c.json({ error: 'bad_batch_size' }, 400);
      const results = body.map((item) => processItem(item as Item));
      const summary: Record<string, number> = {};
      for (const r of results) summary[r.body.status] = (summary[r.body.status] ?? 0) + 1;
      return c.json({ results: results.map((r) => r.body), summary }, 207);
    }
    const r = processItem(body as Item);
    return c.json(r.body, r.http as 200);
  });

  app.get('/api/devices/:imei/readings', (c) => {
    const imei = c.req.param('imei');
    const sensor = [...stored.entries()].filter(([k]) => k.startsWith(`${imei}:`)).map(([, v]) => v.payload);
    return c.json({ device_imei: imei, sensor, location: sensor });
  });

  function processItem(input: Item): { http: number; body: { event_id: string; request_id: string; status: string; warnings: Issue[]; errors: Issue[] } } {
    const warnings: Issue[] = [];
    const errors: Issue[] = [];
    const reply = (http: number, status: string) => ({
      http,
      body: { event_id: randomUUID(), request_id: randomUUID(), status, warnings, errors },
    });
    const p = structuredClone(input ?? {}) as Item;
    const num = (obj: unknown, k: string) => {
      if (obj && typeof obj === 'object' && typeof (obj as Item)[k] === 'string') (obj as Item)[k] = Number((obj as Item)[k]);
    };
    num(p['Temperature'], 'Celsius');
    num(p['Temperature'], 'Fahrenheit');
    num(p['Humidity'], 'Percentage');
    num(p['Cellular'], 'Dbm');

    if (typeof p['DeviceId'] !== 'string' || !/^[0-9]{15}$/.test(p['DeviceId'])) {
      errors.push({ code: 'DEVICE_ID_INVALID', path: 'DeviceId', message: 'DeviceId must be 15 digits' });
    }
    let epoch = p['EntryTimeEpoch'];
    if (typeof epoch !== 'number' || !Number.isInteger(epoch) || epoch < 0) {
      errors.push({ code: 'TIMESTAMP_INVALID', path: 'EntryTimeEpoch', message: 'bad epoch' });
    } else {
      if (epoch < 1e11) {
        epoch *= 1000;
        warnings.push({ code: 'TIMESTAMP_SECONDS_COERCED', path: 'EntryTimeEpoch', message: 'seconds' });
      }
      if ((epoch as number) > Date.now() + 24 * 3_600_000) {
        errors.push({ code: 'TIMESTAMP_FUTURE', path: 'EntryTimeEpoch', message: 'future' });
      }
    }
    const account = p['AccountId'];
    if (opts.accountId !== undefined && account !== undefined && account !== null && account !== opts.accountId) {
      errors.push({ code: 'ACCOUNT_MISMATCH', path: 'AccountId', message: 'AccountId does not match the account of this API key' });
    }
    if (errors.length) return reply(422, 'rejected');

    const probe = p['ProbeTemperature'] as Item | null | undefined;
    if (probe && typeof probe['Celsius'] === 'number' && SENTINELS.has(probe['Celsius'])) {
      warnings.push({ code: 'SENSOR_SENTINEL', path: 'ProbeTemperature.Celsius', message: 'sentinel' });
    }
    const loc = (p['Location'] ?? {}) as Item;
    const lat = loc['Latitude'] as number;
    const lon = loc['Longitude'] as number;
    const locOk = lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 && !(lat === 0 && lon === 0);
    if (!locOk) warnings.push({ code: 'LOCATION_INVALID', path: 'Location', message: 'invalid' });

    const key = `${p['DeviceId']}:${epoch}`;
    const hash = createHash('sha256').update(JSON.stringify(p)).digest('hex');
    const prev = stored.get(key);
    if (prev) return reply(200, prev.hash === hash ? 'duplicate' : 'duplicate_conflict');
    stored.set(key, { hash, payload: p });
    return reply(201, locOk ? 'processed' : 'partial');
  }

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { serve } = await import('@hono/node-server');
  const port = Number(process.env['PORT'] ?? 3000);
  serve({ fetch: createStubApi(process.env['STUB_API_KEY'] ?? 'test-key-local').fetch, port });
  console.log(`stub Integration API on :${port}`);
}
