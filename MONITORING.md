# Monitoring — turning re-scans on in production

Veilguard's monitoring (scheduled re-scans + GitHub push-triggered re-scans, with
optional email alerts) is **fully implemented and tested** in this repo. What it
needs to actually run in production is deployment + configuration — this file is
the runbook. The frontend contributes only the per-app config it writes to
`users/{uid}.apps[].monitoring`; everything below is backend/ops.

## How it works (the moving parts)

| Piece | Endpoint / entry | Trigger | Secret |
|---|---|---|---|
| Scheduled re-scans | `POST /runSchedules` (`functions/src/runSchedules.ts`) | Cloud Scheduler cron | `SCHEDULE_SECRET` (header `x-veilguard-cron`) |
| Push re-scans | `POST /githubWebhook` (`functions/src/githubWebhook.ts`) | GitHub App push webhook | `GITHUB_WEBHOOK_SECRET` (HMAC `X-Hub-Signature-256`) |
| Email alerts | `shared/src/email.ts` → `recordMonitoringResult` | a new critical/high or grade drop | `RESEND_API_KEY` (else console log) |

Both endpoints live on the **API service** (`functions/src/index.ts` →
`createApiApp()`). Both **return 401 for every request when their secret is
unset** — so monitoring is inert-but-safe until you configure it.

## One-time setup

### 0. Prereqs
- Cloud Run worker service deployed and reachable (`WORKER_URL`), Cloud Tasks
  queue `veilguard-scans` created, Admin SA credential available to the services.
- `gcloud` authenticated on project `veilguard-d6710`; Docker running.

### 1. Generate + store the secrets (Secret Manager)
```bash
printf '%s' "$(openssl rand -hex 32)" | gcloud secrets create SCHEDULE_SECRET --data-file=-
printf '%s' "$(openssl rand -hex 32)" | gcloud secrets create GITHUB_WEBHOOK_SECRET --data-file=-
# Optional (email alerts); otherwise alerts only log:
printf '%s' "re_xxx"                  | gcloud secrets create RESEND_API_KEY --data-file=-
```
Keep the `SCHEDULE_SECRET` and `GITHUB_WEBHOOK_SECRET` values handy for steps 3–4.

### 2. Deploy the API service
```bash
PROJECT=veilguard-d6710 REGION=us-central1 npm run deploy:api
```
Note the printed **service URL** (`https://veilguard-api-….run.app`) → this is
`<API_HOST>`. (`scripts/deploy-api.sh` injects the secrets above via
`--set-secrets`; edit its `--set-env-vars` for your `WORKER_URL`/Cloud Tasks
values before the first deploy.)

### 3. Create the Cloud Scheduler job (scheduled cadences)
```bash
PROJECT=veilguard-d6710 REGION=us-central1 \
API_URL=https://veilguard-api-….run.app \
SCHEDULE_SECRET=<value from step 1> \
npm run create-scheduler
```
Runs every 10 min by default (override `SCHEDULE=`). Each tick re-scans only apps
whose cadence is *due*.

### 4. Configure the GitHub App webhook (push cadence)
In the GitHub App settings (the same App used for connected Deep scans):
- **Webhook URL:** `https://<API_HOST>/githubWebhook`
- **Webhook secret:** the `GITHUB_WEBHOOK_SECRET` value from step 1 (must match exactly)
- **Subscribe to events:** **Push** (only)
- Permissions stay read-only (Contents: Read, Metadata: Read) — no new scopes.
- Ensure the App is installed on the repos users connect.

### 5. Point the frontend at the API
Set `NEXT_PUBLIC_BACKEND_URL=https://<API_HOST>` in the frontend's env and redeploy.

## Verify

- **Scheduler:** `curl -X POST https://<API_HOST>/runSchedules -H "x-veilguard-cron: $SCHEDULE_SECRET"` → `200`
  (a wrong/absent header → `401`). Or `gcloud scheduler jobs run veilguard-run-schedules …`.
- **Webhook:** GitHub App → **Advanced → Recent Deliveries → Redeliver** a push →
  `200`; a monitored `push`-cadence app gets a new scan tagged `origin: 'monitor'`,
  and a `monitorEvents` doc appears (visible in the dashboard's alerts/timeline).
- **Email:** with `RESEND_API_KEY` set and a `from` on a Resend-verified domain,
  a re-scan that adds a critical/high finding sends one alert to the user's
  `alertEmail`. Without the key, look for `[email] → …` in the service logs.

## Local dev equivalents

- Scheduled: `npm run schedules` (drives `/runSchedules` against the emulator with
  the dev secret).
- Push: expose the local server (`npm run dev:all`, port 8787) via a tunnel
  (cloudflared/ngrok) and point a test GitHub App webhook at `<tunnel>/githubWebhook`.
- `npm test` covers both handlers end-to-end (`test/monitoring.test.ts`).


