import { randomUUID } from 'node:crypto';
import type { Expectation, Plan, Step } from './types.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface Target {
  /** Base URL of the Integration API, without a trailing slash. */
  url: string;
  apiKey?: string;
  /** True when the URL or key came from a per-request override. */
  overridden?: boolean;
}

export interface SendResult {
  index: number;
  label: string;
  imei: string | null;
  httpStatus: number;
  /** `status` from the response, `batch` for 207, `error` for other non-JSON or error bodies. */
  apiStatus: string;
  warnings: number;
  errors: number;
  warningCodes: string[];
  errorCodes: string[];
  latencyMs: number;
  eventId: string | null;
  /** Number of items in `results` for a batch response. */
  batchSize?: number;
  expect: Expectation;
  matched: boolean;
  mismatch: string | null;
  request: { method: 'POST'; url: string; headers: Record<string, string>; bytes: number; body: unknown };
  response: { headers: Record<string, string>; body: unknown } | null;
  networkError: string | null;
}

export interface RunSummary {
  total: number;
  matched: number;
  unexpected: number;
  networkErrors: number;
  byHttpStatus: Record<string, number>;
  byApiStatus: Record<string, number>;
  warnings: number;
  errors: number;
  latency: { avg: number; p50: number; p95: number; max: number };
}

export interface Run {
  id: string;
  scenario: string;
  seed: number;
  count: number;
  target: { url: string; overridden: boolean; keyConfigured: boolean };
  startedAt: string;
  durationMs: number;
  results: SendResult[];
  summary: RunSummary;
}

export interface SendOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  count?: number;
}

/** Bodies larger than this are kept only as a preview in the run history. */
const PREVIEW_LIMIT = 16 * 1024;

export const WEBHOOK_PATH = '/api/webhook/tive';

export async function runPlan(plan: Plan, target: Target, opts: SendOptions = {}): Promise<Run> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const id = randomUUID();
  const started = Date.now();
  const results: SendResult[] = [];
  // Sequential on purpose: duplicate and conflict cases depend on order.
  for (const [index, step] of plan.steps.entries()) {
    results.push(await sendStep(step, index, id, target, fetchImpl, opts.timeoutMs ?? 15_000));
  }
  return {
    id,
    scenario: plan.scenario,
    seed: plan.seed,
    count: opts.count ?? plan.steps.length,
    target: { url: target.url, overridden: target.overridden ?? false, keyConfigured: Boolean(target.apiKey) },
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    results,
    summary: summarize(results),
  };
}

async function sendStep(
  step: Step,
  index: number,
  runId: string,
  target: Target,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<SendResult> {
  const url = `${target.url}${WEBHOOK_PATH}`;
  const headers: Record<string, string> = {
    'Content-Type': step.contentType,
    'X-Request-Id': `sender-${runId.slice(0, 8)}-${index + 1}`,
  };
  const shownHeaders = { ...headers };
  if (step.auth === 'default' && target.apiKey) {
    headers['X-API-Key'] = target.apiKey;
    shownHeaders['X-API-Key'] = redact(target.apiKey);
  } else if (step.auth === 'wrong') {
    const bad = `wrong-${randomUUID()}`;
    headers['X-API-Key'] = bad;
    shownHeaders['X-API-Key'] = bad;
  }

  const bytes = Buffer.byteLength(step.body);
  const base = {
    index,
    label: step.label,
    imei: step.imei ?? null,
    expect: step.expect,
    request: { method: 'POST' as const, url, headers: shownHeaders, bytes, body: requestPreview(step, bytes) },
  };

  const t0 = performance.now();
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: step.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    const latencyMs = Math.round((performance.now() - t0) * 10) / 10;
    const body = parseMaybe(text);
    const parsed = readBody(res.status, body);
    const { matched, mismatch } = evaluate(step.expect, res.status, parsed);
    return {
      ...base,
      httpStatus: res.status,
      ...parsed,
      latencyMs,
      matched,
      mismatch,
      response: { headers: pickHeaders(res.headers), body },
      networkError: null,
    };
  } catch (err) {
    const latencyMs = Math.round((performance.now() - t0) * 10) / 10;
    const message = err instanceof Error ? `${err.name}: ${err.message}${causeOf(err)}` : String(err);
    return {
      ...base,
      httpStatus: 0,
      apiStatus: 'network_error',
      warnings: 0,
      errors: 0,
      warningCodes: [],
      errorCodes: [],
      eventId: null,
      latencyMs,
      matched: false,
      mismatch: `Network error: ${message}`,
      response: null,
      networkError: message,
    };
  }
}

interface ParsedBody {
  apiStatus: string;
  warnings: number;
  errors: number;
  warningCodes: string[];
  errorCodes: string[];
  eventId: string | null;
  batchSize?: number;
}

type Issue = { code?: unknown };

function codes(list: unknown): string[] {
  return Array.isArray(list) ? list.map((i: Issue) => (typeof i?.code === 'string' ? i.code : '?')) : [];
}

export function readBody(httpStatus: number, body: unknown): ParsedBody {
  const obj = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  if (obj && Array.isArray(obj['results'])) {
    const items = obj['results'] as Record<string, unknown>[];
    const w = items.flatMap((r) => codes(r?.['warnings']));
    const e = items.flatMap((r) => codes(r?.['errors']));
    return { apiStatus: 'batch', warnings: w.length, errors: e.length, warningCodes: unique(w), errorCodes: unique(e), eventId: null, batchSize: items.length };
  }
  if (obj && typeof obj['status'] === 'string') {
    const w = codes(obj['warnings']);
    const e = codes(obj['errors']);
    return {
      apiStatus: obj['status'],
      warnings: w.length,
      errors: e.length,
      warningCodes: unique(w),
      errorCodes: unique(e),
      eventId: typeof obj['event_id'] === 'string' ? obj['event_id'] : null,
    };
  }
  const e = obj ? codes(obj['errors']) : [];
  return {
    apiStatus: httpStatus >= 400 ? 'error' : 'unknown',
    warnings: 0,
    errors: e.length || (httpStatus >= 400 ? 1 : 0),
    warningCodes: [],
    errorCodes: unique(e),
    eventId: obj && typeof obj['event_id'] === 'string' ? obj['event_id'] : null,
  };
}

export function evaluate(expect: Expectation, httpStatus: number, body: ParsedBody): { matched: boolean; mismatch: string | null } {
  const problems: string[] = [];
  if (!expect.httpStatus.includes(httpStatus)) problems.push(`HTTP ${httpStatus}, expected ${expect.httpStatus.join(' or ')}`);
  if (expect.apiStatus && !expect.apiStatus.includes(body.apiStatus)) {
    problems.push(`status ${body.apiStatus}, expected ${expect.apiStatus.join(' or ')}`);
  }
  for (const code of expect.errorCodes ?? []) {
    if (!body.errorCodes.includes(code)) problems.push(`missing error ${code}`);
  }
  if (!body.apiStatus.startsWith('duplicate')) {
    for (const code of expect.warningCodes ?? []) {
      if (!body.warningCodes.includes(code)) problems.push(`missing warning ${code}`);
    }
  }
  if (expect.batchSize !== undefined && body.batchSize !== expect.batchSize) {
    problems.push(`batch returned ${body.batchSize ?? 0} results, expected ${expect.batchSize}`);
  }
  return { matched: problems.length === 0, mismatch: problems.length ? problems.join('; ') : null };
}

export function summarize(results: SendResult[]): RunSummary {
  const lat = results.filter((r) => !r.networkError).map((r) => r.latencyMs).sort((a, b) => a - b);
  const pct = (p: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.ceil((p / 100) * lat.length) - 1)]! : 0);
  const count = (key: (r: SendResult) => string) =>
    results.reduce<Record<string, number>>((acc, r) => {
      acc[key(r)] = (acc[key(r)] ?? 0) + 1;
      return acc;
    }, {});
  const matched = results.filter((r) => r.matched).length;
  return {
    total: results.length,
    matched,
    unexpected: results.length - matched,
    networkErrors: results.filter((r) => r.networkError).length,
    byHttpStatus: count((r) => String(r.httpStatus)),
    byApiStatus: count((r) => r.apiStatus),
    warnings: results.reduce((n, r) => n + r.warnings, 0),
    errors: results.reduce((n, r) => n + r.errors, 0),
    latency: {
      avg: lat.length ? Math.round((lat.reduce((a, b) => a + b, 0) / lat.length) * 10) / 10 : 0,
      p50: pct(50),
      p95: pct(95),
      max: lat.length ? lat[lat.length - 1]! : 0,
    },
  };
}

function requestPreview(step: Step, bytes: number): unknown {
  if (bytes > PREVIEW_LIMIT) {
    return { _preview: true, bytes, head: step.body.slice(0, 600) + '...' };
  }
  return step.payload !== undefined ? step.payload : step.body;
}

function parseMaybe(text: string): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}...` : text;
  }
}

function pickHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ['content-type', 'x-request-id', 'retry-after']) {
    const v = h.get(name);
    if (v) out[name] = v;
  }
  return out;
}

export function redact(key: string): string {
  return key.length <= 4 ? '****' : `****${key.slice(-4)}`;
}

function unique(list: string[]): string[] {
  return [...new Set(list)];
}

function causeOf(err: Error): string {
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) return ` (${cause.message})`;
  if (cause && typeof cause === 'object' && 'code' in cause) return ` (${String((cause as { code: unknown }).code)})`;
  return '';
}
