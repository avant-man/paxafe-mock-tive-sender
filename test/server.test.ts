import { describe, expect, it } from 'vitest';
import { loadConfig, resolveTarget, TargetError } from '../src/config.js';
import { listScenarios } from '../src/generators/index.js';
import { RunHistory } from '../src/history.js';
import type { Run } from '../src/sender.js';
import { createApp } from '../src/server.js';
import { createStubApi } from './support/stubApi.js';

const KEY = 'test-key-local';
const TARGET = 'http://api.test';

function setup(env: Record<string, string> = {}) {
  const stub = createStubApi(KEY);
  const seen: { url: string; headers: Headers }[] = [];
  const fetchImpl = async (input: string, init?: RequestInit) => {
    seen.push({ url: input, headers: new Headers(init?.headers) });
    if (!input.startsWith(TARGET)) throw new TypeError('fetch failed');
    return stub.fetch(new Request(input, init));
  };
  const config = loadConfig({ TARGET_URL: TARGET, TARGET_API_KEY: KEY, ...env });
  const history = new RunHistory(200);
  const app = createApp({ config, fetchImpl, history });
  const send = async (body: unknown) => {
    const res = await app.request('/api/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, run: (await res.json()) as Run };
  };
  return { app, send, seen, history };
}

describe('sender API against a contract stub', () => {
  it('serves health, config, scenarios and the UI', async () => {
    const { app } = setup();
    expect((await app.request('/health')).status).toBe(200);
    const config = await (await app.request('/api/config')).json();
    expect(config).toEqual({ targetUrl: TARGET, keyConfigured: true, allowOverride: true });
    expect(JSON.stringify(config)).not.toContain(KEY);
    const { scenarios } = await (await app.request('/api/scenarios')).json();
    expect(scenarios.length).toBe(listScenarios().length);
    const page = await app.request('/');
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('Mock Tive Sender');
    expect((await app.request('/app.js')).status).toBe(200);
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
    const { send, seen } = setup();
    const { run } = await send({ scenario: 'realistic', count: 1, overrides: { targetUrl: 'http://other.test' } });
    expect(run.results[0]!.httpStatus).toBe(0);
    expect(run.results[0]!.apiStatus).toBe('network_error');
    expect(seen.at(-1)!.url).toBe('http://other.test/api/webhook/tive');
    expect(seen.at(-1)!.headers.get('X-API-Key')).toBeNull();
  });

  it('uses an override key when given', async () => {
    const { send } = setup();
    const { run } = await send({ scenario: 'realistic', count: 1, overrides: { apiKey: 'nope' } });
    expect(run.results[0]!.httpStatus).toBe(401);
  });

  it('rejects overrides when disabled', async () => {
    const { send } = setup({ ALLOW_TARGET_OVERRIDE: 'false' });
    const { status } = await send({ scenario: 'realistic', count: 1, overrides: { targetUrl: 'http://evil.test' } });
    expect(status).toBe(400);
  });

  it('validates the send body', async () => {
    const { send } = setup();
    expect((await send({})).status).toBe(400);
    expect((await send({ scenario: 'nope' })).status).toBe(400);
    expect((await send({ scenario: 'realistic', count: 'x' })).status).toBe(400);
  });

  it('keeps history newest first and serves one run by id', async () => {
    const { app, send } = setup();
    const a = (await send({ scenario: 'realistic', count: 1 })).run;
    const b = (await send({ scenario: 'malformed-json', count: 1 })).run;
    const { runs } = await (await app.request('/api/history')).json();
    expect(runs.map((r: Run) => r.id)).toEqual([b.id, a.id]);
    expect(runs[0].results).toBeUndefined();
    const one = await (await app.request(`/api/history/${a.id}`)).json();
    expect(one.results).toHaveLength(1);
    expect((await app.request('/api/history/missing')).status).toBe(404);
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

  it('caps history at 200 runs', () => {
    const h = new RunHistory(200);
    for (let i = 0; i < 205; i++) h.add({ id: String(i) } as Run);
    expect(h.size).toBe(200);
    expect(h.list()[0]!.id).toBe('204');
  });
});

describe('target resolution', () => {
  const config = loadConfig({ TARGET_URL: 'http://localhost:3000/', TARGET_API_KEY: 'k' });

  it('normalizes the URL and uses the server key for the configured target', () => {
    expect(resolveTarget(config)).toEqual({ url: 'http://localhost:3000', apiKey: 'k', overridden: false });
  });

  it('rejects non-http URLs', () => {
    expect(() => resolveTarget(config, { targetUrl: 'file:///etc/passwd' })).toThrow(TargetError);
    expect(() => resolveTarget(config, { targetUrl: 'not a url' })).toThrow(TargetError);
  });
});
