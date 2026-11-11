import { parseArgs } from 'node:util';
import { loadConfig, loadDotEnv, normalizeUrl, resolveTarget } from './config.js';
import { buildPlan, listScenarios } from './generators/index.js';
import { runPlan, type Run } from './sender.js';

const HELP = `Usage: npm run send -- --scenario <id> [--count N] [--seed N] [--target URL] [--key KEY] [--json] [--list]

Sends generated Tive payloads to the Integration API and prints a results table.
Defaults come from TARGET_URL and TARGET_API_KEY. Exit code 1 when any result
does not match its expected outcome.`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      scenario: { type: 'string', short: 's', default: 'realistic' },
      count: { type: 'string', short: 'n' },
      seed: { type: 'string' },
      target: { type: 'string', short: 't' },
      key: { type: 'string', short: 'k' },
      json: { type: 'boolean', default: false },
      list: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (values.list) {
    for (const s of listScenarios()) console.log(`${s.id.padEnd(22)} ${s.group.padEnd(11)} ${s.description}`);
    return 0;
  }

  loadDotEnv();
  const config = loadConfig();
  const targetUrl = values.target ? normalizeUrl(values.target) : config.targetUrl;
  const target = resolveTarget({ ...config, targetUrl, allowOverride: true }, { apiKey: values.key });
  const plan = buildPlan(values.scenario!, {
    count: values.count ? Number(values.count) : undefined,
    seed: values.seed ? Number(values.seed) : undefined,
  });
  const run = await runPlan(plan, target, { timeoutMs: config.requestTimeoutMs });

  if (values.json) console.log(JSON.stringify(run, null, 2));
  else printRun(run);
  return run.summary.unexpected > 0 ? 1 : 0;
}

function printRun(run: Run): void {
  console.log(`Scenario ${run.scenario}  seed ${run.seed}  target ${run.target.url}  key ${run.target.keyConfigured ? 'set' : 'not set'}`);
  const rows = run.results.map((r) => ({
    '#': String(r.index + 1),
    label: truncate(r.label, 44),
    http: r.httpStatus === 0 ? 'ERR' : String(r.httpStatus),
    status: r.apiStatus,
    warn: String(r.warnings),
    err: String(r.errors),
    ms: r.latencyMs.toFixed(1),
    event: r.eventId ? r.eventId.slice(0, 8) : '-',
    ok: r.matched ? 'yes' : 'NO',
    detail: r.matched ? [...r.warningCodes, ...r.errorCodes].join(',') : (r.mismatch ?? ''),
  }));
  const cols = Object.keys(rows[0] ?? { '#': '' }) as (keyof (typeof rows)[number])[];
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => r[c].length)));
  const line = (cells: string[]) => cells.map((v, i) => v.padEnd(widths[i]!)).join('  ');
  console.log(line(cols));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(cols.map((c) => r[c])));
  const s = run.summary;
  console.log('');
  console.log(
    `${s.total} requests, ${s.matched} as expected, ${s.unexpected} unexpected, ${s.networkErrors} network errors. ` +
      `HTTP ${fmt(s.byHttpStatus)}. Status ${fmt(s.byApiStatus)}. Latency avg ${s.latency.avg} ms, p95 ${s.latency.p95} ms.`,
  );
}

function fmt(map: Record<string, number>): string {
  return Object.entries(map).map(([k, v]) => `${k}:${v}`).join(' ');
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}~` : s;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  },
);
