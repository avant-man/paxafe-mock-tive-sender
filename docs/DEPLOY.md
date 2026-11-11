# Deploy runbook: Mock Tive Sender

Target: one Render free web service (Docker). No database. Cost: 0 USD. Time: about 10 minutes.
Deploy the Integration API first (see `docs/DEPLOY.md` in `paxafe-integration-api`). The sender
needs its URL and a key.

| Part | Where | URL after deploy |
|---|---|---|
| Mock Tive sender | Render free web service, Docker | `https://paxafe-mock-tive-sender.onrender.com` |
| Integration API | Render free web service, Docker | `https://paxafe-integration-api.onrender.com` |

Render may add a suffix to a service name that is taken. Use the URL that the dashboard shows.

## 0. Things to know about free tiers

- A Render free web service spins down after 15 minutes with no inbound traffic. The next
  request waits about 1 minute while it starts. Both the sender and the API sleep, so the first
  send can be slow. `REQUEST_TIMEOUT_MS` is 90000 in `render.yaml` for that reason.
- Render free web services have 1 instance. The sender keeps its run history and its rate
  limit buckets in memory, so a restart or a sleep clears both. That is by design.
- Render gives 750 free instance hours per workspace each month. Two services that sleep when
  idle stay well inside that.
- Render health checks: each request must answer 2xx or 3xx in 5 seconds. `/health` on the
  sender does not call the API, so a sleeping API does not fail the sender's health check.

## 1. Make a key scoped to the demo account

The sender is public. Anyone who opens it can click **Verify**, which calls
`GET /api/devices/:imei/readings` on the API with the sender's `TARGET_API_KEY`. With an
unscoped key (such as the API's `seed` key), a visitor could read the readings of any device
in any account. So the deployed `TARGET_API_KEY` must be a key scoped to the demo account 478.

The API supports account-scoped keys. Render free has no shell, so run this on your laptop
against the production database (`NEON_DIRECT_URL` from the API runbook):

```bash
cd paxafe-integration-api
npm ci
DATABASE_URL="$NEON_DIRECT_URL" npm run create-key -- sender-demo 478
```

It prints `api_key` once. Only its SHA-256 hash is stored, so copy it now.

What a key scoped to 478 means for the sender:

- Every realistic and every edge-case payload uses `AccountId` 478, so all of them pass.
- Verify can read only devices of account 478.
- The sample "Clinical Supply Shipment" has `AccountId` 999. The API rejects it with 422
  `ACCOUNT_MISMATCH`. The sender expects that answer, so the row shows as expected.

## 2. Deploy the sender on Render

1. Push the repo to GitHub. `render.yaml` and `.github/workflows/ci.yml` are at the repo root.
   With `autoDeployTrigger: checksPass`, Render deploys only after CI is green. Without CI,
   change it to `commit`.
2. Render dashboard > **New > Blueprint** > pick `paxafe-mock-tive-sender`, branch `main`.
3. Fill the `sync: false` values:
   - `TARGET_URL`: `https://paxafe-integration-api.onrender.com` (no trailing slash)
   - `TARGET_API_KEY`: the scoped `api_key` from step 1. Never the unscoped seed key.
4. Click **Apply**. The log shows:
   ```
   {"msg":"mock tive sender listening","port":10000,"targetUrl":"https://paxafe-integration-api.onrender.com","keyConfigured":true,"allowOverride":false,"targetAllowlist":[]}
   ```
   `keyConfigured` must be `true` and `allowOverride` must be `false`.

### Settings in `render.yaml`

| Variable | Value | Why |
|---|---|---|
| `ALLOW_TARGET_OVERRIDE` | `false` | When `true`, visitors can point the sender at another host |
| `TARGET_ALLOWLIST` | empty | Hosts that an override may use. Empty blocks every URL override |
| `REQUEST_TIMEOUT_MS` | `90000` | A sleeping API takes about 1 minute to wake |
| `TRUST_PROXY` | `true` | Render sets `X-Forwarded-For`. The per-IP send limit reads it |
| `SEND_RATE_PER_MINUTE` | `10` | Sends per client IP per minute |
| `SEND_RATE_PER_MINUTE_GLOBAL` | `60` | Sends per minute in total. A client can fake `X-Forwarded-For`, so this caps the total load on the API |

### Turning the override on for a reviewer

Only for a short session where a reviewer wants to point the sender at their own API:

1. Dashboard > **Environment**: set `TARGET_ALLOWLIST` to the reviewer's host (for example
   `reviewer-api.onrender.com`) and `ALLOW_TARGET_OVERRIDE` to `true`. **Save and deploy**.
2. The reviewer enters the URL and their own key in **Target override**. The server key is
   never sent to an override URL.
3. Set `ALLOW_TARGET_OVERRIDE` back to `false` and clear `TARGET_ALLOWLIST` after the session.

Even with the override on, a host that resolves to a loopback, private, link-local or metadata
address (169.254.169.254) is refused, also at connect time. Redirects are never followed.

## 3. Smoke test the live URLs

```bash
API=https://paxafe-integration-api.onrender.com
SENDER=https://paxafe-mock-tive-sender.onrender.com
KEY='<the scoped sender-demo key>'

# 1. Wake both services. The first call can take about 1 minute.
curl -sS --max-time 120 "$API/health"       # {"status":"ok","db":"ok"}
curl -sS --max-time 120 "$SENDER/health"    # {"status":"ok",...}

# 2. The sender reaches the API.
curl -sS "$SENDER/api/target/health"        # httpStatus 200, body.db "ok"

# 3. Overrides are off.
curl -sS -H 'X-Target-Url: http://169.254.169.254' "$SENDER/api/target/health"   # 400 bad_target

# 4. Send one realistic run (20 readings, 3 trucks) through the sender.
curl -sS -X POST "$SENDER/api/send" -H 'content-type: application/json' \
  -d '{"scenario":"realistic","count":20,"seed":42}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["summary"])'
# expect: total 20, matched 20, unexpected 0, networkErrors 0, byHttpStatus {"201": 20}

# 5. Read the data back. A scoped key reads only account 478.
curl -sS -H "X-API-Key: $KEY" "$API/api/devices/864475040010017/readings?limit=5"

# 6. The edge-case suite and the samples: every case must match its expected outcome.
for s in edge-suite samples; do
  curl -sS -X POST "$SENDER/api/send" -H 'content-type: application/json' -d "{\"scenario\":\"$s\"}" \
    | python3 -c 'import json,sys; s=json.load(sys.stdin)["summary"]; print(s); assert s["unexpected"]==0'
done

# 7. The same check from a laptop, without the sender UI:
LIVE_TARGET_URL="$API" LIVE_TARGET_KEY="$KEY" npm test -- contract.live
```

Also open `$SENDER` in a browser. Pick **Realistic fleet**, click send, and check that every row
is green. The IMEI `864475040010017` is the first truck of the fixed demo fleet.

## 4. Operate

- **Logs**: Render dashboard > service > **Logs**. The sender writes JSON lines.
- **Redeploy**: push to `main`. Or dashboard > **Manual Deploy > Deploy latest commit**.
- **Rollback**: dashboard > service > **Events** > pick an earlier deploy > **Rollback**.
- **Rotate the sender key**: make a new scoped key (step 1), put it in `TARGET_API_KEY`,
  **Save and deploy**, then revoke the old key in the API database.
- **Shutdown**: Render sends SIGTERM and waits up to 30 seconds. The sender closes the HTTP
  server and forces exit after 10 seconds, so a run in flight cannot hold the shutdown.

## 5. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Sender run shows `networkErrors` on the first send | The API was asleep | Send again. Keep `REQUEST_TIMEOUT_MS=90000` |
| Every row is 401 | `TARGET_API_KEY` is wrong or not set | Set the scoped key and deploy |
| Realistic rows are 422 `ACCOUNT_MISMATCH` | The key is scoped to an account other than 478 | Make a key scoped to 478 |
| Clinical Supply Shipment is 422 `ACCOUNT_MISMATCH` | Expected with a key scoped to 478 | Nothing to fix. It shows as expected |
| Sender returns 400 `Target overrides are disabled` | `ALLOW_TARGET_OVERRIDE=false` | Expected on the public URL |
| Sender returns 400 `not on TARGET_ALLOWLIST` | Override on, host not listed | Add the host to `TARGET_ALLOWLIST` |
| Sender returns 429 `rate_limited` | More than 10 sends a minute from one IP, or 60 in total | Wait for `Retry-After` seconds |
| History is empty after a visit | The sender slept or restarted (history is in memory), or the browser blocks cookies | Expected. Send again |
| All Render services suspended | 750 free hours used up for the month | Wait for the next month or upgrade |
