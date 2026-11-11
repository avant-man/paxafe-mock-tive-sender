# PAXAFE Mock Tive Sender

This app generates Tive webhook payloads and sends them to the PAXAFE Integration API
(`POST /api/webhook/tive`). It shows what the API answered. Every request carries the outcome
that the design spec expects, so each run is also a contract check of the API. It has a single
page UI, a small JSON API and a CLI. It has no database.

## Live deployment

```text
Mock Tive sender: <SENDER_URL>
Integration API:  <API_URL>
```

The deploy step fills in these values. The sender keeps its own API key on the server, so you
do not need a key to use the UI. A free Render service sleeps after 15 minutes. The first send
can take about 1 minute, because both services wake up.

The API repo is `paxafe-integration-api`. Its README has the API reference and the error codes.

## Contents

1. [Quick start (local)](#1-quick-start-local)
2. [Scenarios](#2-scenarios)
3. [UI](#3-ui)
4. [CLI](#4-cli)
5. [JSON API](#5-json-api)
6. [Security model](#6-security-model)
7. [Tests](#7-tests)
8. [Deploy](#8-deploy)
9. [Known limits](#9-known-limits)

## 1. Quick start (local)

You need Node.js 22 or later. Start the Integration API first (see its README), on
`http://localhost:3000` with the key `test-key-local`.

```bash
npm install
cp .env.example .env          # TARGET_URL=http://localhost:3000, TARGET_API_KEY=test-key-local
npm run dev                   # http://localhost:4000
```

Open `http://localhost:4000`, pick a scenario and click **Send**. Or use the CLI in a second
terminal:

```bash
npm run send -- --scenario edge-suite
npm run send -- --scenario samples
```

**No API running?** `npm run stub` starts a small in-memory stand-in on port 3000 with the key
`test-key-local`. It follows the response contract. The tests use it too.

**Port 4000 is taken?** Run `PORT=4400 npm run dev`. Real environment variables win over `.env`.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `TARGET_URL` | `http://localhost:3000` | Base URL of the Integration API, no trailing slash |
| `TARGET_API_KEY` | none | Sent as `X-API-Key`. It stays on the server and never goes to the browser |
| `PORT` | `4000` | Port of this sender |
| `ALLOW_TARGET_OVERRIDE` | `false` | `true` lets the UI and the JSON API change the target URL or key per request |
| `TARGET_ALLOWLIST` | empty | Comma separated hosts that an override URL may use. Empty blocks every URL override |
| `REQUEST_TIMEOUT_MS` | `15000` | Timeout for each request to the target. `render.yaml` sets 90000 |
| `SEND_RATE_PER_MINUTE` | `10` | Sends per client IP per minute on `/api/send` |
| `SEND_RATE_PER_MINUTE_GLOBAL` | `60` | Sends per minute in total on `/api/send` |
| `TRUST_PROXY` | `false` | `true` reads the client IP from the first `X-Forwarded-For` entry. Use it only behind a proxy that sets it (Render) |

## 2. Scenarios

The table comes from `src/generators/` (`index.ts`, `edgeCases.ts`, `samples.ts`).
"Breaks" is the one rule that the scenario breaks. Each edge case changes one valid payload in
one place.

| Scenario | What it sends | Breaks | Expected API result | Count (default / max) |
|---|---|---|---|---|
| `realistic` | 3 trucks on real lanes (Pharr TX to Bronx NY, Memphis to Chicago, Durham to Boston). 2 to 8 °C with noise, a possible excursion, battery drain, GPS, WiFi or cell fixes, 15 minutes apart | nothing | 201 `processed` | readings, 20 / 200 |
| `samples` | The 13 payloads from `schemas/sample-tive-payloads.json`, in file order | per sample (see below) | per sample (see below) | samples, 13 / 13 |
| `invalid-coordinates` | Latitude 95, longitude -200, 0,0 or latitude -91, in turn | Location validity | 201 `partial` + `LOCATION_INVALID` | instances, 4 / 20 |
| `missing-device-id` | `DeviceId` missing, 14 digits, or with letters, in turn | `DeviceId` is 15 digits | 422 `rejected` + `DEVICE_ID_INVALID` | instances, 3 / 20 |
| `epoch-seconds` | `EntryTimeEpoch` in seconds | Epoch in milliseconds | 201 `processed` + `TIMESTAMP_SECONDS_COERCED` | instances, 1 / 20 |
| `numeric-strings` | Temperature, humidity and Dbm as strings | Numeric fields are JSON numbers | 201 `processed` | instances, 1 / 20 |
| `sentinel-probe` | Probe temperature 327.67, -327.68, 32767, -32768, -3276.8 or 3276.7, in turn | Temperatures are not sentinels | 201 `processed` + `SENSOR_SENTINEL` | instances, 2 / 20 |
| `duplicate-resend` | The same body twice | Idempotency key stored once | 201 `processed`, then 200 `duplicate` | instances, 1 / 20 |
| `conflicting-resend` | Same device and timestamp, temperature 1.5 °C higher | First write wins | 201 `processed`, then 200 `duplicate_conflict` | instances, 1 / 20 |
| `future-timestamp` | `EntryTimeEpoch` 48 hours ahead | At most 24 h in the future | 422 `rejected` + `TIMESTAMP_FUTURE` | instances, 1 / 20 |
| `malformed-json` | A valid payload cut off 17 characters before the end | Body is valid JSON | 400 | instances, 1 / 20 |
| `wrong-api-key` | A bad key, then no key, in turn | Valid API key | 401 | instances, 2 / 20 |
| `wrong-content-type` | Valid JSON sent as `text/plain` | `Content-Type` is JSON | 415 | instances, 1 / 20 |
| `oversized-body` | A valid payload padded to about 1.06 MB | Body is at most 1 MB | 413 | instances, 1 / 3 |
| `batch` | K valid readings in one array (count = K) | 1 to 100 items per batch | 207 with K results. 400 above 100 | batch size, 10 / 150 |
| `edge-suite` | One of every edge case above, with a batch of 5 | as above | as above (15 requests) | ignored, 1 / 1 |

`GET /api/scenarios` and `npm run send -- --list` show the same list.

Each run uses a seed (a seeded mulberry32 RNG). Send the same seed again to send the same
payloads. Edge cases use random IMEIs, so new runs do not collide with earlier data. The
realistic fleet uses fixed IMEIs, so readings from many runs build a history on 3 devices.

### Expected result for each sample

| Sample | Expected | Also accepted |
|---|---|---|
| Standard Temperature Shipment, GPS Location Shipment, Standard Temperature Shipment Update, Minimal Data Payload, Vaccine Shipment Southbound | 201 `processed` | 200 `duplicate` on a second run |
| Vaccine Shipment Checkpoint, Cellular Location Only | 201 `processed` + `SENSOR_SENTINEL` | 200 `duplicate` |
| Biologics Replenishment Shipment | 201 `processed` + `TIMESTAMP_SECONDS_COERCED` | 200 `duplicate` |
| Device A571992 Reading, Device A571992 Follow-up Reading | 200 `duplicate_conflict` (same key as the first sample) | 201 `partial` when sent alone |
| Device Name Only, Entity and Device Name | 422 `rejected` + `DEVICE_ID_INVALID` | none |
| Clinical Supply Shipment | 422 `rejected` + `ACCOUNT_MISMATCH` with a key scoped to account 478 | 201 `processed` or 200 `duplicate` with an unscoped key |

Every realistic and edge-case payload uses `AccountId` 478 (`DEMO_ACCOUNT_ID` in
`src/generators/realistic.ts`). A key scoped to account 478 works for all of them. The sample
"Clinical Supply Shipment" has `AccountId` 999, so a scoped key gets `ACCOUNT_MISMATCH`.

The sender judges each answer against the response contract, not only the HTTP status. A
`201` with a missing warning code shows as unexpected.

## 3. UI

- **Scenario**, **count** and an optional **Seed**, then **Send**.
- **Check target** calls the target `/health` through the sender.
- **Results** table: request label, HTTP status, API status, warning and error counts, latency,
  event id and whether the answer was as expected. Each row opens the request and response
  JSON. The API key in the request shows only its last 4 characters.
- **Verify** reads `GET /api/devices/:imei/readings` on the API through the sender, so you can
  see what the API stored.
- **History** lists the runs of your browser session, newest first.
- **Target override (testing)** shows only when the server allows overrides (section 6).
- Plain HTML, CSS and one ES module, served by the same Hono server. There is no build step.
  It works on a phone (the table turns into cards) and in dark mode.

## 4. CLI

```bash
npm run send -- --scenario realistic --count 20 [--seed 42] [--target URL] [--key KEY] [--json]
npm run send -- --list
npm run send -- --help
```

- It reads `TARGET_URL` and `TARGET_API_KEY` from the environment or `.env`. `--target` and `--key` win over them.
- It prints a table and a summary line.
- The exit code is 1 when any result does not match its expected outcome. So the CLI also works as a smoke test after a deploy.

Example output (samples, second run against a local API):

```text
13 requests, 13 as expected, 0 unexpected, 0 network errors. HTTP 200:11 422:2. Status duplicate:9 duplicate_conflict:2 rejected:2.
```

## 5. JSON API

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Liveness of the sender. It does not call the API |
| GET | `/api/config` | Target URL, whether a key is set, whether overrides are allowed |
| GET | `/api/scenarios` | Scenario list with `defaultCount` and `maxCount` |
| POST | `/api/send` | `{ "scenario": "realistic", "count": 20, "seed": 42, "overrides": { "targetUrl": "...", "apiKey": "..." } }`. Runs the scenario and returns the run |
| GET | `/api/history` | Run summaries of this browser session, newest first |
| GET | `/api/history/:id` | One run of this session with every request and response. 404 for a run of another session |
| GET | `/api/verify/:imei?limit=20` | Proxies `GET /api/devices/:imei/readings` on the target with the server key |
| GET | `/api/target/health` | Proxies the target `/health` |

- `verify` and `target/health` take overrides as `X-Target-Url` and `X-Target-Key` headers, with the same checks as `/api/send`.
- A run holds one result per request. A result has the label, IMEI, HTTP status, API status, codes, latency, event id, the expectation and the match.
- A result also keeps the request and the response. Bodies above 16 KB are kept as a preview only.
- Errors: 400 `bad_request`, 400 `bad_target`, 400 `unknown_scenario`, 429 `rate_limited` with `Retry-After`. `verify` and `target/health` answer 502 when the target cannot be reached. In a run, a network error is a result with HTTP status 0.

## 6. Security model

**No key in the browser.** `TARGET_API_KEY` stays on the server. `/api/config` says only
whether a key is set. Stored requests show the key as its last 4 characters. On a public
deployment the key must be scoped to the demo account 478. Then **Verify** can read only that
account's devices.

**Target override is off by default** (`ALLOW_TARGET_OVERRIDE=false`, also in `render.yaml`).
A key-only override also needs it. When it is on, a URL override must pass every check below,
or the request gets 400 `bad_target` and nothing is sent:

1. The URL is an origin only (`https://host[:port]`). No path, query, fragment or credentials.
2. The host is on `TARGET_ALLOWLIST` (exact match, case insensitive).
3. Every address that the host resolves to is public. The guard blocks loopback, private
   (RFC 1918, IPv6 ULA), link-local (with the metadata address 169.254.169.254), CGNAT,
   multicast, reserved and documentation ranges, NAT64 and IPv4-mapped forms of these.
4. The address check runs again when the socket connects (an undici `Agent` with a guarded
   `lookup`). So a DNS answer that changes after step 3 (DNS rebinding) is blocked too.

The sender never follows redirects. It sends the server key only to `TARGET_URL`. A request
that overrides the URL and gives no key sends no key.

**Rate limits.** `/api/send` has a token bucket per client IP (10 per minute) and one in total
(60 per minute). The total bucket is the backstop when a client fakes `X-Forwarded-For`. The
send body is at most 64 KB. Each scenario has a count limit (section 2), so a run has at most
200 requests.

**Session history.** Every response sets a `sender_session` cookie when the request has none.
It is a random UUID, `HttpOnly`, `SameSite=Lax`, `Secure` over HTTPS, valid for 7 days. Runs
are stored with that id, so each browser sees only its own runs. There is no endpoint to clear
history.

**Headers.** A strict Content-Security-Policy (`script-src 'self'`, no inline script),
`X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` are on every response.

## 7. Tests

```bash
npm test             # 99 pass, 16 live tests skip
npm run typecheck
npm run lint
LIVE_TARGET_URL=http://localhost:3000 LIVE_TARGET_KEY=test-key-local npm test -- contract.live   # 16 live tests
```

| Suite | Tests | What it proves |
|---|---|---|
| `test/server.test.ts` | 34 | Every scenario against the in-memory contract stub matches its expectation, with an unscoped key and with a key scoped to 478. Key handling, overrides, session history, rate limits, count limits, verify |
| `test/targetGuard.test.ts` | 29 | Blocked address ranges, the allowlist, origin-only URLs, and a real socket test: a host that resolves to loopback is refused at connect time |
| `test/edgeCases.test.ts` | 18 | Each edge case differs from its valid base only on its intended paths. It fails the Tive schema only at those paths, when it should fail |
| `test/realistic.test.ts` | 18 | Every realistic payload (25 seeds x 40 readings) passes ajv against `schemas/tive-incoming-schema.json`. A seeded run is stable (snapshot) |
| `test/contract.live.test.ts` | 16 | Every scenario against a real API. It runs only when `LIVE_TARGET_URL` and `LIVE_TARGET_KEY` are set. CI skips it |

CI (`.github/workflows/ci.yml`) runs typecheck, lint, the tests and the build. It then builds
the Docker image and checks `/health` in it.

## 8. Deploy

`render.yaml` defines one Docker web service on Render (free plan, region `oregon`). It deploys
after CI passes. Set `TARGET_URL` and `TARGET_API_KEY` in the dashboard. The key must be scoped
to the demo account 478 (`npm run create-key -- sender-demo 478` in the API repo).
[`docs/DEPLOY.md`](docs/DEPLOY.md) has the steps, the smoke test and the steps to let a
reviewer use their own API for one session.

## 9. Known limits

- Run history and rate-limit buckets live in memory. A restart or a free-tier sleep clears them. The history keeps the last 200 runs in total.
- The per-IP limit reads the first `X-Forwarded-For` entry when `TRUST_PROXY=true`. A client can fake that entry, so the global limit is the real backstop.
- Requests in a run go one at a time, because order matters for the duplicate and conflict cases. A long run against a slow API takes a long time.
- The scenarios cover the rules in the design spec. They do not cover every hostile input that the API tests cover (for example NUL characters or deep nesting).
- The UI shows one run at a time. It has no charts and no export.
- The sender has no login. On a public URL, anyone can send runs, inside the rate limits.

With more time, I would add a scenario for each API hardening rule, a CSV export of a run, and
a scheduled smoke run of `edge-suite` against the live API.
