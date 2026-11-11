import type { Target } from './sender.js';

export interface Config {
  port: number;
  targetUrl: string;
  targetApiKey: string | undefined;
  /** When false, the UI and API cannot change the target URL or key. */
  allowOverride: boolean;
  requestTimeoutMs: number;
}

/** Loads `.env` from the working directory when present (local runs only). */
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
    allowOverride: (env['ALLOW_TARGET_OVERRIDE'] ?? 'true').toLowerCase() !== 'false',
    requestTimeoutMs: Number(env['REQUEST_TIMEOUT_MS'] ?? 15_000),
  };
}

export class TargetError extends Error {}

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

/**
 * Picks the target for one request. The server key is only ever sent to the
 * configured TARGET_URL: if the caller overrides the URL without a key, no key is sent.
 */
export function resolveTarget(config: Config, overrides: Overrides = {}): Target {
  const urlOverride = overrides.targetUrl?.trim() || undefined;
  const keyOverride = overrides.apiKey?.trim() || undefined;
  if ((urlOverride || keyOverride) && !config.allowOverride) {
    throw new TargetError('Target overrides are disabled on this server (ALLOW_TARGET_OVERRIDE=false)');
  }
  const url = urlOverride ? normalizeUrl(urlOverride) : config.targetUrl;
  const sameHost = url === config.targetUrl;
  const apiKey = keyOverride ?? (sameHost ? config.targetApiKey : undefined);
  return { url, apiKey, overridden: Boolean(urlOverride || keyOverride) };
}
