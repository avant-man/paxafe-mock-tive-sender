// Mock Tive Sender UI. Plain DOM, no build step. All text goes in through textContent.

const $ = (id) => document.getElementById(id);

const state = {
  scenarios: [],
  config: null,
  run: null,
  history: [],
  expanded: new Set(),
};

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

async function api(path, init = {}) {
  const res = await fetch(path, init);
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok && res.status !== 502) {
    const msg = body && typeof body === 'object' ? body.message || body.error : text;
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return body;
}

function overrideHeaders() {
  const h = {};
  const url = $('override-url').value.trim();
  const key = $('override-key').value.trim();
  if (url) h['X-Target-Url'] = url;
  if (key) h['X-Target-Key'] = key;
  return h;
}

// ---------- chips ----------

function statusTone(status) {
  switch (status) {
    case 'processed': return 'ok';
    case 'partial':
    case 'duplicate':
    case 'duplicate_conflict': return 'warn';
    case 'batch': return 'info';
    case 'rejected':
    case 'failed':
    case 'error':
    case 'network_error': return 'bad';
    default: return '';
  }
}

function httpTone(code) {
  if (code === 0) return 'bad';
  if (code < 300) return 'ok';
  if (code < 500) return 'warn';
  return 'bad';
}

const chip = (text, tone = '') => el('span', { class: `chip ${tone}`.trim(), text });

// ---------- setup ----------

async function init() {
  const [{ scenarios }, config] = await Promise.all([api('/api/scenarios'), api('/api/config')]);
  state.scenarios = scenarios;
  state.config = config;

  $('target-url').textContent = config.targetUrl;
  const pill = $('key-pill');
  pill.textContent = config.keyConfigured ? 'server key set' : 'no server key';
  pill.className = `pill chip ${config.keyConfigured ? 'ok' : 'warn'}`;
  if (!config.allowOverride) $('override-box').hidden = true;

  const select = $('scenario');
  const groups = new Map();
  for (const s of scenarios) {
    if (!groups.has(s.group)) groups.set(s.group, el('optgroup', { label: s.group }));
    groups.get(s.group).append(el('option', { value: s.id, text: s.label }));
  }
  for (const g of groups.values()) select.append(g);
  select.addEventListener('change', onScenarioChange);
  onScenarioChange();

  $('send-form').addEventListener('submit', onSend);
  $('check-target').addEventListener('click', checkTarget);
  $('only-unexpected').addEventListener('change', renderResults);

  await loadHistory();
  if (state.history[0]) await openRun(state.history[0].id);
  checkTarget();
}

function currentScenario() {
  return state.scenarios.find((s) => s.id === $('scenario').value);
}

function onScenarioChange() {
  const s = currentScenario();
  if (!s) return;
  $('scenario-desc').textContent = s.description;
  const count = $('count');
  count.max = String(s.maxCount);
  count.value = String(s.defaultCount);
  count.disabled = s.countMeaning === 'ignored';
  const meaning = { readings: 'Readings', samples: 'Samples', instances: 'Instances', 'batch size': 'Batch size', ignored: 'Count' };
  $('count-label').textContent = meaning[s.countMeaning] || 'Count';
  $('count-hint').textContent = s.countMeaning === 'ignored' ? 'Not used for this scenario.' : `1 to ${s.maxCount}.`;
}

async function checkTarget() {
  const dot = $('target-dot');
  dot.className = 'dot';
  try {
    const r = await api('/api/target/health', { headers: overrideHeaders() });
    const up = r && r.httpStatus >= 200 && r.httpStatus < 300;
    dot.className = `dot ${up ? 'up' : 'down'}`;
    dot.title = up ? `Target up (${r.latencyMs} ms)` : `Target answered ${r.httpStatus || r.error}`;
  } catch (err) {
    dot.className = 'dot down';
    dot.title = err.message;
  }
}

// ---------- send ----------

async function onSend(event) {
  event.preventDefault();
  const s = currentScenario();
  const btn = $('send-btn');
  const status = $('send-status');
  const count = Number($('count').value);
  const seedRaw = $('seed').value.trim();
  const overrides = {};
  if ($('override-url').value.trim()) overrides.targetUrl = $('override-url').value.trim();
  if ($('override-key').value.trim()) overrides.apiKey = $('override-key').value.trim();

  btn.disabled = true;
  status.className = 'status';
  status.textContent = `Sending ${s.label}...`;
  try {
    const run = await api('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scenario: s.id,
        count: Number.isFinite(count) ? count : undefined,
        seed: seedRaw === '' ? undefined : Number(seedRaw),
        overrides,
      }),
    });
    state.run = run;
    state.expanded.clear();
    status.textContent = `Done in ${run.durationMs} ms. Seed ${run.seed}.`;
    render();
    await loadHistory();
  } catch (err) {
    status.className = 'status error';
    status.textContent = `Send failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

// ---------- render ----------

function render() {
  renderSummary();
  renderResults();
  renderHistory();
}

function renderSummary() {
  const box = $('summary');
  const run = state.run;
  if (!run) { box.hidden = true; return; }
  const s = run.summary;
  const stat = (k, v, tone = '') => el('div', { class: 'stat' }, el('span', { class: 'k', text: k }), el('span', { class: `v ${tone}`, text: v }));
  box.replaceChildren(
    stat('Requests', String(s.total)),
    stat('As expected', String(s.matched), s.unexpected === 0 ? 'ok' : ''),
    stat('Unexpected', String(s.unexpected), s.unexpected > 0 ? 'bad' : ''),
    stat('Avg latency', `${s.latency.avg} ms`),
    stat('p95', `${s.latency.p95} ms`),
    stat('Warnings / errors', `${s.warnings} / ${s.errors}`),
    el('div', { class: 'chips', 'aria-label': 'HTTP status counts' },
      Object.entries(s.byHttpStatus).map(([k, v]) => chip(`${k === '0' ? 'ERR' : k} x${v}`, httpTone(Number(k))))),
    el('div', { class: 'chips', 'aria-label': 'API status counts' },
      Object.entries(s.byApiStatus).map(([k, v]) => chip(`${k} x${v}`, statusTone(k)))),
    el('span', { class: 'muted small-text', text: `${run.scenario}, seed ${run.seed}, ${run.target.url}${run.target.overridden ? ' (override)' : ''}` }),
  );
  box.hidden = false;
}

function renderResults() {
  const run = state.run;
  const body = $('results-body');
  const table = $('results-table');
  if (!run) { table.hidden = true; $('empty').hidden = false; return; }
  const only = $('only-unexpected').checked;
  const rows = run.results.filter((r) => !only || !r.matched);
  $('empty').hidden = rows.length > 0;
  $('empty').textContent = rows.length ? '' : only ? 'Every result matched its expected outcome.' : 'No results.';
  table.hidden = rows.length === 0;

  body.replaceChildren(...rows.flatMap((r) => {
    const open = state.expanded.has(r.index);
    const detailId = `detail-${r.index}`;
    const tr = el('tr', { class: `item ${r.matched ? '' : 'unexpected'}` },
      el('td', { 'data-label': '#', class: 'num', text: String(r.index + 1) }),
      el('td', { 'data-label': 'Request', class: 'wide' },
        el('div', { class: 'label', text: r.label }),
        el('div', { class: 'note', text: r.expect.note, title: expectationText(r.expect) }),
        r.imei ? el('div', { class: 'codes mono', text: r.imei }) : null),
      el('td', { 'data-label': 'HTTP' }, chip(r.httpStatus === 0 ? 'ERR' : String(r.httpStatus), httpTone(r.httpStatus))),
      el('td', { 'data-label': 'API status' }, chip(r.apiStatus, statusTone(r.apiStatus)),
        r.batchSize !== undefined ? el('div', { class: 'codes', text: `${r.batchSize} items` }) : null),
      el('td', { 'data-label': 'Warnings', class: 'num' }, String(r.warnings),
        r.warningCodes.length ? el('div', { class: 'codes', text: r.warningCodes.join(', ') }) : null),
      el('td', { 'data-label': 'Errors', class: 'num' }, String(r.errors),
        r.errorCodes.length ? el('div', { class: 'codes', text: r.errorCodes.join(', ') }) : null),
      el('td', { 'data-label': 'Latency', class: 'num', text: `${r.latencyMs} ms` }),
      el('td', { 'data-label': 'Event id', class: 'mono', title: r.eventId || '', text: r.eventId ? r.eventId.slice(0, 8) : '-' }),
      el('td', { 'data-label': 'Expected' },
        r.matched ? chip('as expected', 'ok') : chip('unexpected', 'bad'),
        r.mismatch ? el('div', { class: 'mismatch', text: r.mismatch }) : null),
      el('td', { 'data-label': 'Actions', class: 'wide' },
        el('div', { class: 'row-actions' },
          el('button', {
            type: 'button', class: 'btn small', 'aria-expanded': String(open), 'aria-controls': detailId,
            text: open ? 'Hide JSON' : 'JSON',
            onclick: () => { if (open) state.expanded.delete(r.index); else state.expanded.add(r.index); renderResults(); },
          }),
          r.imei && /^[0-9]{15}$/.test(r.imei)
            ? el('button', { type: 'button', class: 'btn small', text: 'Verify', 'aria-label': `Verify device ${r.imei}`, onclick: () => verify(r.imei) })
            : null)),
    );
    if (!open) return [tr];
    const detail = el('tr', { class: 'detail', id: detailId },
      el('td', { colspan: '10' },
        el('div', { class: 'detail-grid' },
          el('div', {},
            el('h3', { text: `Request  POST ${r.request.url}  (${r.request.bytes} bytes)` }),
            el('pre', { class: 'json', text: pretty({ headers: r.request.headers, body: r.request.body }) })),
          el('div', {},
            el('h3', { text: r.networkError ? 'Network error' : `Response  HTTP ${r.httpStatus}` }),
            el('pre', { class: 'json', text: r.networkError ? r.networkError : pretty(r.response) })))));
    return [tr, detail];
  }));
}

function renderHistory() {
  const list = $('history');
  if (state.history.length === 0) {
    list.replaceChildren(el('li', { class: 'muted', text: 'No runs yet.' }));
    return;
  }
  list.replaceChildren(...state.history.map((h) => el('li', {},
    el('button', {
      type: 'button',
      'aria-current': state.run && state.run.id === h.id ? 'true' : null,
      onclick: () => openRun(h.id),
    },
      el('strong', { text: h.scenario }),
      el('span', { class: 'when', text: new Date(h.startedAt).toLocaleString() }),
      chip(`${h.summary.matched}/${h.summary.total} as expected`, h.summary.unexpected ? 'bad' : 'ok'),
      el('span', { class: 'when', text: `avg ${h.summary.latency.avg} ms, seed ${h.seed}` })))));
}

async function loadHistory() {
  const { runs } = await api('/api/history');
  state.history = runs;
  renderHistory();
}

async function openRun(id) {
  state.run = await api(`/api/history/${encodeURIComponent(id)}`);
  state.expanded.clear();
  render();
}

// ---------- verify ----------

async function verify(imei) {
  const dialog = $('verify-dialog');
  $('verify-title').textContent = `Verify ${imei}`;
  $('verify-meta').textContent = 'Loading readings from the Integration API...';
  $('verify-summary').replaceChildren();
  $('verify-body').textContent = '';
  if (!dialog.open) dialog.showModal();
  try {
    const r = await api(`/api/verify/${imei}?limit=20`, { headers: overrideHeaders() });
    $('verify-meta').textContent = r.error
      ? `GET ${r.url} failed: ${r.error}`
      : `GET ${r.url}  HTTP ${r.httpStatus}  ${r.latencyMs} ms`;
    const chips = [chip(r.httpStatus ? `HTTP ${r.httpStatus}` : 'ERR', httpTone(r.httpStatus || 0))];
    if (r.body && typeof r.body === 'object') {
      for (const [k, v] of Object.entries(r.body)) {
        if (Array.isArray(v)) chips.push(chip(`${k}: ${v.length} rows`, v.length ? 'ok' : 'warn'));
      }
    }
    $('verify-summary').replaceChildren(...chips);
    $('verify-body').textContent = pretty(r.body ?? r.error);
  } catch (err) {
    $('verify-meta').textContent = `Verify failed: ${err.message}`;
  }
}

function expectationText(e) {
  const one = (x) => [
    `HTTP ${x.httpStatus.join(' or ')}`,
    x.apiStatus ? `status ${x.apiStatus.join(' or ')}` : null,
    x.errorCodes?.length ? `errors ${x.errorCodes.join(', ')}` : null,
    x.warningCodes?.length ? `warnings ${x.warningCodes.join(', ')}` : null,
  ].filter(Boolean).join(', ');
  const alts = (e.alternatives || []).map((a) => ` Also expected: ${one(a)}.`).join('');
  return `Expected: ${one(e)}.${alts}`;
}

function pretty(v) {
  return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
}

init().catch((err) => {
  $('send-status').className = 'status error';
  $('send-status').textContent = `Could not load: ${err.message}`;
});
