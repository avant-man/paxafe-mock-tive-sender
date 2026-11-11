import type { Target } from './sender.js';
import { checkOverrideUrl, parseAllowlist, TargetError } from './targetGuard.js';

export interface Config {
  port: number;
  targetUrl: string;
  targetApiKey: string | undefined;
  allowOverride: boolean;
  targetAllowlist: string[];
  requestTimeoutMs: number;
  sendPerMinute: number;
  sendPerMinuteGlobal: number;
  trustProxy: boolean;
}

export function loadDotEnv(): void {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: use the real environment.
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env['PORT'] ?? 4000),
    targetUrl: normalizeUrl(env['TARGET_URL'] ?? 'http://localhost:3000'),
    targetApiKey: env['TARGET_API_KEY'] || undefined,
    allowOverride: (env['ALLOW_TARGET_OVERRIDE'] ?? 'false').toLowerCase() === 'true',
    targetAllowlist: parseAllowlist(env['TARGET_ALLOWLIST']),
    requestTimeoutMs: Number(env['REQUEST_TIMEOUT_MS'] ?? 15_000),
    sendPerMinute: positive(env['SEND_RATE_PER_MINUTE'], 10),
    sendPerMinuteGlobal: positive(env['SEND_RATE_PER_MINUTE_GLOBAL'], 60),
    trustProxy: (env['TRUST_PROXY'] ?? 'false').toLowerCase() === 'true',
  };
}

function positive(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && Number.isFinite(n) && n > 0 ? n : fallback;
}

export { TargetError };

export function normalizeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new TargetError(`Not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TargetError('Target URL must use http or https');
  return url.toString().replace(/\/+$/, '');
}

export interface Overrides {
  targetUrl?: string | undefined;
  apiKey?: string | undefined;
}

// Never send the server key to an overridden URL.
export function resolveTarget(config: Config, overrides: Overrides = {}): Target {
  const urlOverride = overrides.targetUrl?.trim() || undefined;
  const keyOverride = overrides.apiKey?.trim() || undefined;
  if ((urlOverride || keyOverride) && !config.allowOverride) {
    throw new TargetError('Target overrides are disabled on this server (ALLOW_TARGET_OVERRIDE=false)');
  }
  let url = urlOverride ? normalizeUrl(urlOverride) : config.targetUrl;
  const urlOverridden = url !== config.targetUrl;
  if (urlOverridden) url = normalizeUrl(checkOverrideUrl(url, config.targetAllowlist).origin);
  const apiKey = keyOverride ?? (urlOverridden ? undefined : config.targetApiKey);
  return { url, apiKey, overridden: Boolean(urlOverride || keyOverride), urlOverridden };
}
