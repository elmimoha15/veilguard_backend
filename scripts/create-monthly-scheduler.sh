#!/usr/bin/env bash
#
# Create (or update) the Cloud Scheduler job that drives Veilguard's MONTHLY
# security summary email. It POSTs /runMonthlySummary on the deployed API service
# once a month; the handler emails every opted-in user (users/{uid}.notifications
# .summary !== false) a branded recap of their apps' grades, fixed vs open issues,
# and scans used.
#
# The request carries the shared secret in the `x-veilguard-cron` header, which
# must equal the API service's SCHEDULE_SECRET or the handler returns 401.
#
# Usage:
#   PROJECT=veilguard-d6710 REGION=us-central1 \
#   API_URL=https://veilguard-api-xxxx.run.app \
#   SCHEDULE_SECRET=<same-as-the-service> \
#   bash scripts/create-monthly-scheduler.sh
set -euo pipefail

PROJECT="${PROJECT:-veilguard-d6710}"
REGION="${REGION:-us-central1}"
JOB="${JOB:-veilguard-monthly-summary}"
SCHEDULE="${SCHEDULE:-0 9 1 * *}"   # 09:00 on the 1st of each month
: "${API_URL:?Set API_URL to the deployed API service base URL}"
: "${SCHEDULE_SECRET:?Set SCHEDULE_SECRET (must match the API service)}"

URI="${API_URL%/}/runMonthlySummary"

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
