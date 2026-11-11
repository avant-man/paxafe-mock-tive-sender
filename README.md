# PAXAFE Mock Tive Sender

Generates Tive webhook payloads, sends them to the PAXAFE Integration API
(`POST /api/webhook/tive`) and shows what came back. Every request carries an expected
outcome from the design spec, so each run is also a contract check of the API.

- Single page UI: pick a scenario and count, send, read the results table.
- JSON API for the UI and for scripts.
- CLI: `npm run send -- --scenario realistic --count 20`.
- No database. Run history lives in memory (last 200 runs) and is lost on restart.

## Quick start

```bash
npm install
cp .env.example .env          # set TARGET_URL and TARGET_API_KEY
npm run dev                   # http://localhost:4000
npm run send -- --scenario edge-suite
```

No API running? `npm run stub` starts a small in-memory stand-in on port 3000 (key
`test-key-local`) that follows the response contract. The tests use it too.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `TARGET_URL` | `http://localhost:3000` | Base URL of the Integration API |
| `TARGET_API_KEY` | none | Sent as `X-API-Key`. Stays on the server, never sent to the browser |
| `PORT` | `4000` | Port of this sender |
| `ALLOW_TARGET_OVERRIDE` | `true` | Lets the UI and API change the target URL and key per request |
| `REQUEST_TIMEOUT_MS` | `15000` | Timeout for each request to the target |

The server key is sent only to `TARGET_URL`. If a request overrides the URL and gives no
key, no key is sent. That keeps the key from leaking to a URL that a visitor types in.
Set `ALLOW_TARGET_OVERRIDE=false` on a public deployment to turn the override off, which
also removes the sender as an open relay to other hosts.

## Scenarios

| Id | What it sends | Expected answer |
|---|---|---|
| `realistic` | N readings from 3 trucks on real lanes (Pharr TX to Bronx NY, Memphis to Chicago, Durham to Boston). 2-8 C with noise, maybe one excursion to about 11 C, battery drain, GPS, WiFi or cell fixes with matching accuracy, 15 minutes apart, newest at now | 201 `processed` |
| `samples` | The 13 payloads from `schemas/sample-tive-payloads.json` | Per sample, from the spec (2 rejected, 2 conflicts with the first sample) |
| `invalid-coordinates` | Latitude 95, longitude -200, 0,0 or latitude -91 (rotating) | 201 `partial` + `LOCATION_INVALID` |
| `missing-device-id` | DeviceId missing, 14 digits, or with letters | 422 `DEVICE_ID_INVALID` |
| `epoch-seconds` | `EntryTimeEpoch` in seconds | 201 + `TIMESTAMP_SECONDS_COERCED` |
| `numeric-strings` | Temperature, humidity and Dbm as strings | 201 `processed` |
| `sentinel-probe` | Probe temperature 327.67, -32768 and the other sentinels | 201 + `SENSOR_SENTINEL` |
| `duplicate-resend` | The same body twice | 201 `processed`, then 200 `duplicate` |
| `conflicting-resend` | Same device and timestamp, other temperature | 201, then 200 `duplicate_conflict` |
| `future-timestamp` | 48 h in the future | 422 `TIMESTAMP_FUTURE` |
| `malformed-json` | A payload cut off before the end | 400 |
| `wrong-api-key` | Bad key, then no key (alternating) | 401 |
| `wrong-content-type` | Valid JSON sent as `text/plain` | 415 |
| `oversized-body` | A valid payload padded to about 1.06 MB | 413 |
| `batch` | K valid readings in one array (count = K) | 207 with K results, 400 above 100 |
| `edge-suite` | One of every edge case | as above |

Each edge case changes one valid payload in one place, so it breaks exactly one rule.
Edge cases use random IMEIs, so reruns do not collide with earlier data. The realistic
fleet uses fixed IMEIs, so readings from many runs build up on the same 3 devices and
the Verify button shows a history.

`duplicate` is accepted for the samples, because their keys are fixed and a second run
repeats them.

## JSON API

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Liveness of the sender |
| GET | `/api/config` | Target URL, whether a key is set, whether overrides are allowed |
| GET | `/api/scenarios` | Scenario list with count limits |
| POST | `/api/send` | `{ "scenario": "realistic", "count": 20, "seed": 42, "overrides": { "targetUrl": "...", "apiKey": "..." } }`. Runs the scenario and returns the run |
| GET | `/api/history` | Run summaries, newest first |
| GET | `/api/history/:id` | One run with every request and response |
| GET | `/api/verify/:imei` | Proxies `GET /api/devices/:imei/readings` on the target with the server key |
| GET | `/api/target/health` | Proxies the target `/health` |

`verify` and `target/health` take overrides as `X-Target-Url` and `X-Target-Key` headers.

A run has one result per request: label, IMEI, HTTP status, API status, warning and
error codes, latency, event id, the expectation and whether it matched, plus the request
(key redacted to the last 4 characters) and the response. Bodies above 16 KB are kept as
a preview only.

## CLI

```bash
npm run send -- --scenario realistic --count 20 [--seed 42] [--target URL] [--key KEY] [--json]
npm run send -- --list
```

It prints a table and a summary. The exit code is 1 when any result does not match its
expected outcome, so it can run as a smoke test after a deploy.

## Design notes

- Generators in `src/generators/` are pure functions of `(seed, now, count)`. A seeded
  mulberry32 RNG makes runs reproducible: enter the seed from a past run to send the same
  payloads again.
- Requests in a run go one at a time. Duplicate and conflict cases depend on order, and
  per-request latency stays easy to read. A run is capped at 200 requests.
- Results are judged against the response contract in the API design spec, not only by
  HTTP status, so a 201 with the wrong warning still shows as unexpected.
- The UI is plain HTML, CSS and a small ES module, served by the same Hono server. No
  build step. It works on a phone (the table turns into cards) and in dark mode. A strict
  Content-Security-Policy blocks inline script.

## Tests

```bash
npm test          # vitest
npm run typecheck
```

- Every realistic payload (25 seeds x 40 readings) and every edge-case base payload passes
  ajv against `schemas/tive-incoming-schema.json`.
- Each edge case differs from its valid base only on its intended paths, and fails the
  schema (when it should) only at those paths.
- A seeded realistic run is stable (snapshot).
- The server runs every scenario against the in-memory contract stub and every result
  matches its expectation. Key handling, overrides, history and verify are covered too.

## Deploy

`render.yaml` defines a Docker web service on Render. Set `TARGET_URL` and
`TARGET_API_KEY` in the dashboard. Free-tier services sleep, so the first request after a
pause can take about 30 s. `REQUEST_TIMEOUT_MS` is 30000 there for that reason.

```bash
docker build -t mock-tive-sender .
docker run -p 4000:4000 -e TARGET_URL=http://host.docker.internal:3000 -e TARGET_API_KEY=... mock-tive-sender
```
