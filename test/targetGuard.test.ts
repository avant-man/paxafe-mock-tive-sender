import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertPublicHost, checkOverrideUrl, guardedFetch, isBlockedAddress, TargetError } from '../src/targetGuard.js';

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1',
    '127.255.0.9',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '169.254.0.1',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    'fd00:ec2::254',
    'not-an-ip',
  ])('blocks %s', (a) => expect(isBlockedAddress(a)).toBe(true));

  it.each(['8.8.8.8', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows %s', (a) =>
    expect(isBlockedAddress(a)).toBe(false),
  );
});

describe('checkOverrideUrl', () => {
  it('needs an allowlisted host and an origin only', () => {
    expect(checkOverrideUrl('https://api.example.com', ['api.example.com']).origin).toBe('https://api.example.com');
    expect(() => checkOverrideUrl('https://API.example.com', [])).toThrow(/not on TARGET_ALLOWLIST/);
    expect(() => checkOverrideUrl('https://api.example.com/x', ['api.example.com'])).toThrow(/origin only/);
    expect(() => checkOverrideUrl('https://api.example.com?x=1', ['api.example.com'])).toThrow(/origin only/);
  });
});

describe('with real DNS and a real socket', () => {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? '');
    res.end('internal');
  });
  let port = 0;
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('assertPublicHost refuses a name that resolves to loopback', async () => {
    await expect(assertPublicHost('localhost')).rejects.toThrow(TargetError);
    await expect(assertPublicHost('127.0.0.1')).rejects.toThrow(/blocked address/);
  });

  it('guardedFetch refuses to connect to loopback at connect time', async () => {
    await expect(guardedFetch(`http://localhost:${port}/admin`)).rejects.toThrow();
    expect(hits).toEqual([]);
  });
});
