#!/usr/bin/env bash
#
# Create (or update) the Cloud Scheduler job that drives Veilguard's scheduled
# re-scans. It POSTs /runSchedules on the deployed API service on a fixed cron;
# the handler then enqueues a re-scan for every monitored app whose cadence is
# due (weekly / biweekly / monthly / daily). Push-triggered scans do NOT go
# through here — those arrive via the GitHub webhook (see MONITORING.md).
#
# The request carries the shared secret in the `x-veilguard-cron` header, which
# must equal the API service's SCHEDULE_SECRET or the handler returns 401.
#
# Prereqs: the API service is deployed (scripts/deploy-api.sh) and you know its
# URL; SCHEDULE_SECRET is set (same value the service has). Run from anywhere.
#
# Usage:
#   PROJECT=veilguard-d6710 REGION=us-central1 \
#   API_URL=https://veilguard-api-xxxx.run.app \
#   SCHEDULE_SECRET=<same-as-the-service> \
#   bash scripts/create-scheduler.sh
set -euo pipefail

PROJECT="${PROJECT:-veilguard-d6710}"
REGION="${REGION:-us-central1}"
JOB="${JOB:-veilguard-run-schedules}"
SCHEDULE="${SCHEDULE:-*/10 * * * *}"   # every 10 minutes
: "${API_URL:?Set API_URL to the deployed API service base URL}"
: "${SCHEDULE_SECRET:?Set SCHEDULE_SECRET (must match the API service)}"

URI="${API_URL%/}/runSchedules"

# `create` fails if the job already exists, so update in that case (idempotent).
if gcloud scheduler jobs describe "$JOB" --project "$PROJECT" --location "$REGION" >/dev/null 2>&1; then
  ACTION=update
else
  ACTION=create
fi

echo "→ ${ACTION} scheduler job $JOB → POST $URI ($SCHEDULE)"
gcloud scheduler jobs "$ACTION" http "$JOB" \
  --project "$PROJECT" \
  --location "$REGION" \
  --schedule "$SCHEDULE" \
  --uri "$URI" \
  --http-method POST \
  --headers "x-veilguard-cron=${SCHEDULE_SECRET}" \
  --attempt-deadline 300s

echo "✓ Done. Test it now with:"
echo "    gcloud scheduler jobs run $JOB --project $PROJECT --location $REGION"
