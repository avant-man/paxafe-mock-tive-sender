import { describe, expect, it } from 'vitest';
import { loadConfig, resolveTarget, TargetError } from '../src/config.js';
import { listScenarios } from '../src/generators/index.js';
import { RunHistory } from '../src/history.js';
import type { Run } from '../src/sender.js';
import { createApp } from '../src/server.js';
import { createStubApi } from './support/stubApi.js';

const KEY = 'test-key-local';
const TARGET = 'http://api.test';

/** Fake DNS for the override address check. */
const DNS: Record<string, string[]> = {
  'other.test': ['93.184.216.34'],
  'api.test': ['93.184.216.35'],
  'rebind.test': ['127.0.0.1'],
  'meta.test': ['169.254.169.254'],
  'lan.test': ['8.8.8.8', '10.0.0.5'],
  'v6.test': ['::1'],
  'mapped.test': ['::ffff:127.0.0.1'],
};
const resolveHost = async (host: string) => DNS[host] ?? [host];

function setup(env: Record<string, string> = {}, now?: () => number, stubOpts: { accountId?: number } = {}) {
  const stub = createStubApi(KEY, stubOpts);
  const seen: { url: string; headers: Headers; redirect: RequestRedirect | undefined }[] = [];
  const fetchImpl = async (input: string, init?: RequestInit) => {
    seen.push({ url: input, headers: new Headers(init?.headers), redirect: init?.redirect });
    if (!input.startsWith(TARGET)) throw new TypeError('fetch failed');
    return stub.fetch(new Request(input, init));
  };
  const config = loadConfig({
    TARGET_URL: TARGET,
    TARGET_API_KEY: KEY,
    SEND_RATE_PER_MINUTE: '1000',
    SEND_RATE_PER_MINUTE_GLOBAL: '1000',
    ...env,
  });
  const history = new RunHistory(200);
  const app = createApp({ config, fetchImpl, overrideFetchImpl: fetchImpl, resolveHost, history, ...(now ? { now } : {}) });
  // One browser: keep the session cookie the server sets.
  let cookie = '';
  const request = async (path: string, init: RequestInit = {}, jar = true) => {
    const headers = new Headers(init.headers);
    if (jar && cookie) headers.set('Cookie', cookie);
    const res = await app.request(path, { ...init, headers });
    const set = res.headers.get('set-cookie');
    if (jar && set) cookie = set.split(';')[0]!;
    return res;
  };
  const send = async (body: unknown, extraHeaders: Record<string, string> = {}) => {
    const res = await request('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
      body: JSON.stringify(body),
    });
    return { status: res.status, run: (await res.json()) as Run, res };
  };
  return { app, request, send, seen, history };
}

const OVERRIDE_ON = { ALLOW_TARGET_OVERRIDE: 'true', TARGET_ALLOWLIST: 'other.test, api.test,rebind.test,meta.test,lan.test,v6.test,mapped.test,127.0.0.1,[::1]' };

describe('sender API against a contract stub', () => {
  it('serves health, config, scenarios and the UI', async () => {
    const { app } = setup();
    expect((await app.request('/health')).status).toBe(200);
    const config = await (await app.request('/api/config')).json();
    expect(config).toEqual({ targetUrl: TARGET, keyConfigured: true, allowOverride: false, targetAllowlist: [] });
    expect(JSON.stringify(config)).not.toContain(KEY);
    const { scenarios } = await (await app.request('/api/scenarios')).json();
    expect(scenarios.length).toBe(listScenarios().length);
    const page = await app.request('/');
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('Mock Tive Sender');
    expect((await app.request('/app.js')).status).toBe(200);
  });

  it('answers 413 for a send body over 64 KB, not 500', async () => {
    const { send } = setup();
    const { status, run } = await send({ scenario: 'realistic', pad: 'x'.repeat(70 * 1024) });
    expect(status).toBe(413);
    expect(run).toMatchObject({ error: 'body_too_large' });
  });

  it('rejects a count that is not a whole number of at least 1', async () => {
    const { send } = setup();
    for (const count of [0, -5, 1.5]) {
      const { status } = await send({ scenario: 'realistic', count });
      expect(status).toBe(400);
    }
  });

  it('runs every scenario and every result matches its expectation', async () => {
    const { send } = setup();
    for (const s of listScenarios()) {
      if (s.id === 'samples') continue; // Samples share keys on purpose, checked below.
      const count = s.countMeaning === 'batch size' ? 10 : Math.min(3, s.maxCount);
      const { status, run } = await send({ scenario: s.id, count, seed: 42 });
      expect(status).toBe(200);
      const bad = run.results.filter((r) => !r.matched).map((r) => `${r.label}: ${r.mismatch}`);
      expect(bad, s.id).toEqual([]);
    }
  });

  it('samples: matches the expected outcome per sample', async () => {
    const { send } = setup();
    const { run } = await send({ scenario: 'samples' });
    expect(run.results).toHaveLength(13);
    expect(run.results.filter((r) => !r.matched).map((r) => `${r.label}: ${r.mismatch}`)).toEqual([]);
  });

  it('with a key scoped to the demo account, every scenario still matches', async () => {
    const { send } = setup({}, undefined, { accountId: 478 });
    for (const s of listScenarios()) {
      const count = s.countMeaning === 'batch size' ? 10 : Math.min(3, s.maxCount);
      const { run } = await send({ scenario: s.id, count, seed: 42 });
      expect(run.results.filter((r) => !r.matched).map((r) => `${r.label}: ${r.mismatch}`), s.id).toEqual([]);
    }
    const { run } = await send({ scenario: 'samples' });
    const clinical = run.results.find((r) => r.label === 'Clinical Supply Shipment')!;
    expect(clinical.httpStatus).toBe(422);
    expect(clinical.errorCodes).toEqual(['ACCOUNT_MISMATCH']);
  });

  it('expects and gets 400 for a batch above 100', async () => {
    const { send } = setup();
    const { run } = await send({ scenario: 'batch', count: 120 });
    expect(run.results[0]!.httpStatus).toBe(400);
    expect(run.results[0]!.matched).toBe(true);
  });

  it('never echoes the server key in results', async () => {
    const { send } = setup();
    const { run } = await send({ scenario: 'realistic', count: 2, seed: 1 });
    expect(JSON.stringify(run)).not.toContain(KEY);
    expect(run.results[0]!.request.headers['X-API-Key']).toBe('****ocal');
  });

  it('does not send the server key to an overridden URL', async () => {
    const { send, seen } = setup(OVERRIDE_ON);
    const { run } = await send({ scenario: 'realistic', count: 1, overrides: { targetUrl: 'http://other.test' } });
    expect(run.results[0]!.httpStatus).toBe(0);
    expect(run.results[0]!.apiStatus).toBe('network_error');
    expect(seen.at(-1)!.url).toBe('http://other.test/api/webhook/tive');
    expect(seen.at(-1)!.headers.get('X-API-Key')).toBeNull();
  });

  it('uses an override key when given', async () => {
    const { send } = setup(OVERRIDE_ON);
    const { run } = await send({ scenario: 'realistic', count: 1, overrides: { apiKey: 'nope' } });
    expect(run.results[0]!.httpStatus).toBe(401);
  });

  it('rejects overrides by default and when disabled', async () => {
    for (const env of [{}, { ALLOW_TARGET_OVERRIDE: 'false', TARGET_ALLOWLIST: 'evil.test' }] as Record<string, string>[]) {
      const { app, send, seen } = setup(env);
      expect((await send({ scenario: 'realistic', count: 1, overrides: { targetUrl: 'http://evil.test' } })).status).toBe(400);
      expect((await send({ scenario: 'realistic', count: 1, overrides: { apiKey: 'other' } })).status).toBe(400);
      expect((await app.request('/api/target/health', { headers: { 'X-Target-Url': 'http://evil.test' } })).status).toBe(400);
      expect(seen).toHaveLength(0);
    }
  });

  describe('SSRF guard when overrides are on', () => {
    const blockedCases: [string, RegExp][] = [
      ['http://not-listed.test', /not on TARGET_ALLOWLIST/],
      ['http://rebind.test', /blocked address \(127\.0\.0\.1\)/],
      ['http://meta.test', /169\.254\.169\.254/],
      ['http://lan.test', /10\.0\.0\.5/],
      ['http://v6.test', /::1/],
      ['http://mapped.test', /::ffff:127\.0\.0\.1/],
      ['http://127.0.0.1:9', /blocked address/],
      ['http://[::1]:9', /blocked address/],
      ['http://169.254.169.254', /not on TARGET_ALLOWLIST/],
      ['http://other.test/admin/secret?x=', /origin only/],
      ['http://user:pw@other.test', /credentials/],
    ];

    for (const [url, message] of blockedCases) {
      it(`refuses ${url}`, async () => {
        const { app, send, seen } = setup(OVERRIDE_ON);
        const r = await send({ scenario: 'realistic', count: 1, overrides: { targetUrl: url } });
        expect(r.status).toBe(400);
        expect((r.run as unknown as { message: string }).message).toMatch(message);
        const h = await app.request('/api/target/health', { headers: { 'X-Target-Url': url } });
        expect(h.status).toBe(400);
        const v = await app.request('/api/verify/864475040010017', { headers: { 'X-Target-Url': url } });
        expect(v.status).toBe(400);
        expect(seen).toHaveLength(0);
      });
    }

    it('allows an allowlisted public host and sends no server key to it', async () => {
      const { app, seen } = setup(OVERRIDE_ON);
      await app.request('/api/target/health', { headers: { 'X-Target-Url': 'http://other.test' } });
      expect(seen.at(-1)!.url).toBe('http://other.test/health');
      expect(seen.at(-1)!.headers.get('X-API-Key')).toBeNull();
    });
  });

  it('validates the send body', async () => {
    const { send } = setup();
    expect((await send({})).status).toBe(400);
    expect((await send({ scenario: 'nope' })).status).toBe(400);
    expect((await send({ scenario: 'realistic', count: 'x' })).status).toBe(400);
  });

  it('keeps history newest first and serves one run by id', async () => {
    const { request, send } = setup();
    const a = (await send({ scenario: 'realistic', count: 1 })).run;
    const b = (await send({ scenario: 'malformed-json', count: 1 })).run;
    const { runs } = await (await request('/api/history')).json();
    expect(runs.map((r: Run) => r.id)).toEqual([b.id, a.id]);
    expect(runs[0].results).toBeUndefined();
    const one = await (await request(`/api/history/${a.id}`)).json();
    expect(one.results).toHaveLength(1);
    expect((await request('/api/history/missing')).status).toBe(404);
  });

  it('scopes history to the browser session cookie', async () => {
    const { app, request, send } = setup();
    const { run, res } = await send({ scenario: 'realistic', count: 1 });
    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/^sender_session=[0-9a-f-]{36};/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect((await (await request('/api/history')).json()).runs).toHaveLength(1);
    // Another browser (no cookie, or another id) sees nothing, not even by run id.
    const other = { Cookie: 'sender_session=00000000-0000-4000-8000-000000000000' };
    expect((await (await app.request('/api/history', { headers: other })).json()).runs).toEqual([]);
    expect((await app.request(`/api/history/${run.id}`, { headers: other })).status).toBe(404);
    expect((await (await app.request('/api/history')).json()).runs).toEqual([]);
  });

  it('has no public DELETE for the history', async () => {
    const { request, send } = setup();
    await send({ scenario: 'realistic', count: 1 });
    expect((await request('/api/history', { method: 'DELETE' })).status).toBe(404);
    expect((await (await request('/api/history')).json()).runs).toHaveLength(1);
  });

  it('rate limits /api/send per client IP, with Retry-After', async () => {
    let t = 1_000_000;
    const { send } = setup({ SEND_RATE_PER_MINUTE: '2', TRUST_PROXY: 'true' }, () => t);
    const ip = (a: string) => ({ 'X-Forwarded-For': `${a}, 10.0.0.1` });
    expect((await send({ scenario: 'malformed-json', count: 1 }, ip('1.1.1.1'))).status).toBe(200);
    expect((await send({ scenario: 'malformed-json', count: 1 }, ip('1.1.1.1'))).status).toBe(200);
    const third = await send({ scenario: 'malformed-json', count: 1 }, ip('1.1.1.1'));
    expect(third.status).toBe(429);
    expect(third.res.headers.get('retry-after')).toBe('30');
    // Another IP has its own bucket.
    expect((await send({ scenario: 'malformed-json', count: 1 }, ip('2.2.2.2'))).status).toBe(200);
    t += 30_000; // one token back
    expect((await send({ scenario: 'malformed-json', count: 1 }, ip('1.1.1.1'))).status).toBe(200);
  });

  it('has a global send limit as a backstop for spoofed IPs', async () => {
    const { send } = setup({ SEND_RATE_PER_MINUTE: '100', SEND_RATE_PER_MINUTE_GLOBAL: '2', TRUST_PROXY: 'true' }, () => 0);
    for (const a of ['1.1.1.1', '2.2.2.2']) expect((await send({ scenario: 'malformed-json' }, { 'X-Forwarded-For': a })).status).toBe(200);
    expect((await send({ scenario: 'malformed-json' }, { 'X-Forwarded-For': '3.3.3.3' })).status).toBe(429);
  });

  it('caps count per request at the scenario limit', async () => {
    const { send } = setup();
    const tooMany = await send({ scenario: 'oversized-body', count: 4 });
    expect(tooMany.status).toBe(400);
    expect(JSON.stringify(tooMany.run)).toContain('at most 3');
    expect((await send({ scenario: 'realistic', count: 201 })).status).toBe(400);
    expect((await send({ scenario: 'realistic', count: 200 })).status).toBe(200);
  });

  it('never follows redirects from the target', async () => {
    const { app, send, seen } = setup();
    await send({ scenario: 'realistic', count: 1 });
    expect(seen.at(-1)!.redirect).toBe('manual');
    await app.request('/api/target/health');
    expect(seen.at(-1)!.redirect).toBe('manual');
  });

  it('verify proxies the readings endpoint with the server key', async () => {
    const { app, send, seen } = setup();
    const { run } = await send({ scenario: 'realistic', count: 1, seed: 9 });
    const imei = run.results[0]!.imei!;
    const res = await app.request(`/api/verify/${imei}`);
    const body = await res.json();
    expect(body.httpStatus).toBe(200);
    expect(body.body.sensor).toHaveLength(1);
    expect(seen.at(-1)!.url).toBe(`${TARGET}/api/devices/${imei}/readings?limit=20`);
    expect(seen.at(-1)!.headers.get('X-API-Key')).toBe(KEY);
    expect((await app.request('/api/verify/123')).status).toBe(400);
  });

  it('caps history at 200 runs in total', () => {
    const h = new RunHistory(200);
    for (let i = 0; i < 205; i++) h.add({ id: String(i) } as Run);
    expect(h.size).toBe(200);
    expect(h.list()[0]!.id).toBe('204');
  });
});

describe('target resolution', () => {
  const config = loadConfig({ TARGET_URL: 'http://localhost:3000/', TARGET_API_KEY: 'k' });

  it('normalizes the URL and uses the server key for the configured target', () => {
    expect(resolveTarget(config)).toEqual({ url: 'http://localhost:3000', apiKey: 'k', overridden: false, urlOverridden: false });
  });

  it('defaults to overrides off and reads the allowlist', () => {
    expect(loadConfig({}).allowOverride).toBe(false);
    expect(loadConfig({ ALLOW_TARGET_OVERRIDE: 'TRUE', TARGET_ALLOWLIST: ' A.example.com, b.example.com ,' }).targetAllowlist).toEqual([
      'a.example.com',
      'b.example.com',
    ]);
  });

  it('rejects non-http URLs', () => {
    const config = loadConfig({ TARGET_URL: 'http://localhost:3000/', TARGET_API_KEY: 'k', ALLOW_TARGET_OVERRIDE: 'true' });
    expect(() => resolveTarget(config, { targetUrl: 'file:///etc/passwd' })).toThrow(TargetError);
    expect(() => resolveTarget(config, { targetUrl: 'not a url' })).toThrow(TargetError);
  });
});
