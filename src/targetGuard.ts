import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import type { FetchLike } from './sender.js';

export class TargetError extends Error {}

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96], // NAT64, can reach IPv4 space
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
  ['fd00:ec2::254', 128],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return blocked.check(mapped[1]!, 'ipv4');
    if (/^::ffff:/i.test(address)) return true; // hex form of a mapped address: refuse
    return blocked.check(address, 'ipv6');
  }
  return true;
}

export function parseAllowlist(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase().replace(/^\[|\]$/g, ''))
    .filter(Boolean);
}

export function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

export function checkOverrideUrl(raw: string, allowlist: readonly string[]): URL {
  const url = new URL(raw);
  if (url.username || url.password) throw new TargetError('Target URL must not contain credentials');
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new TargetError('Target URL override must be an origin only, for example https://api.example.com');
  }
  const host = hostOf(url);
  if (!allowlist.includes(host)) {
    throw new TargetError(`Target host ${host} is not on TARGET_ALLOWLIST`);
  }
  return url;
}

export type ResolveHost = (host: string) => Promise<string[]>;

export const resolveHostDns: ResolveHost = (host) =>
  new Promise((resolve, reject) => {
    if (isIP(host)) return resolve([host]);
    dnsLookup(host, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(new TargetError(`Cannot resolve ${host}: ${err.code ?? err.message}`));
      else resolve((addresses as LookupAddress[]).map((a) => a.address));
    });
  });

export async function assertPublicHost(host: string, resolveHost: ResolveHost = resolveHostDns): Promise<void> {
  const addresses = await resolveHost(host);
  if (addresses.length === 0) throw new TargetError(`Cannot resolve ${host}`);
  const bad = addresses.find(isBlockedAddress);
  if (bad) throw new TargetError(`Target host ${host} resolves to a blocked address (${bad})`);
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

function guardedLookup(hostname: string, options: { all?: boolean }, callback: LookupCallback): void {
  dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err, []);
    const list = addresses as LookupAddress[];
    const bad = list.find((a) => isBlockedAddress(a.address));
    if (list.length === 0 || bad) {
      const e = new Error(`blocked address for ${hostname}${bad ? ` (${bad.address})` : ''}`) as NodeJS.ErrnoException;
      e.code = 'EBLOCKED';
      return callback(e, []);
    }
    if (options.all) return callback(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
}

let agent: Agent | undefined;

// Rechecks addresses at connect time against DNS rebinding. IP literals skip DNS.
export const guardedFetch: FetchLike = (input, init) => {
  agent ??= new Agent({ connect: { lookup: guardedLookup as never } });
  return undiciFetch(input, { ...(init as object), redirect: 'manual', dispatcher: agent }) as unknown as Promise<Response>;
};
