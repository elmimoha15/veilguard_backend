#!/usr/bin/env bash
#
# Deploy the Veilguard API service (functions/src/index.ts) to Cloud Run.
#
# This service hosts the public Express app, INCLUDING the monitoring endpoints
# POST /runSchedules and POST /githubWebhook. The scan worker is a separate
# service (see scripts/deploy-worker or worker/Dockerfile).
#
# The image build needs the PARENT of both repos as its context (to pull in the
# local `veilguard-scanner` dependency), so this script builds + pushes an image
# and then deploys by --image (rather than `gcloud run deploy --source`, which
# can't reach the parent dir).
#
# Prereqs: gcloud auth configured, Docker running, Artifact Registry repo exists,
# and the secrets below created in Secret Manager (see MONITORING.md).
#
# Usage (from the veilguard-backend dir):
#   PROJECT=veilguard-d6710 REGION=us-central1 bash scripts/deploy-api.sh
set -euo pipefail

PROJECT="${PROJECT:-veilguard-d6710}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-veilguard-api}"
REPO="${REPO:-veilguard}"          # Artifact Registry repository name
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/${SERVICE}:latest"

# Build context = the directory containing BOTH veilguard-backend/ and
# veilguard-scanner/ (this script lives in veilguard-backend/scripts).
BACKEND_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONTEXT_DIR="$(cd "$BACKEND_DIR/.." && pwd)"

echo "→ Building $IMAGE (context: $CONTEXT_DIR)"
docker build -f "$BACKEND_DIR/functions/Dockerfile" -t "$IMAGE" "$CONTEXT_DIR"

echo "→ Pushing $IMAGE"
docker push "$IMAGE"

echo "→ Deploying Cloud Run service $SERVICE"
# Non-secret env vars. Secrets (SCHEDULE_SECRET, GITHUB_WEBHOOK_SECRET,
# RESEND_API_KEY, ENCRYPTION_KEY, …) are injected from Secret Manager via
# --set-secrets so their values never appear on the command line. Adjust the
# WORKER_URL / CLOUD_TASKS_* values to your project before first deploy.
gcloud run deploy "$SERVICE" \
  --project "$PROJECT" \
  --region "$REGION" \
  --image "$IMAGE" \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars "GCLOUD_PROJECT=${PROJECT},QUEUE_IMPL=cloudtasks,CLOUD_TASKS_LOCATION=${REGION},CLOUD_TASKS_QUEUE=veilguard-scans" \
  --set-secrets "SCHEDULE_SECRET=SCHEDULE_SECRET:latest,GITHUB_WEBHOOK_SECRET=GITHUB_WEBHOOK_SECRET:latest,RESEND_API_KEY=RESEND_API_KEY:latest,ENCRYPTION_KEY=ENCRYPTION_KEY:latest"

echo "✓ Deployed. Service URL:"
gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format='value(status.url)'
