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

# ── Runtime config ──────────────────────────────────────────────────────────
# Public URLs (custom domains). Callbacks/webhooks are built off OAUTH_CALLBACK_BASE.
OAUTH_CALLBACK_BASE="${OAUTH_CALLBACK_BASE:-https://api.veilguard.dev}"
FRONTEND_URL="${FRONTEND_URL:-https://veilguard.dev}"
APP_BASE_URL="${APP_BASE_URL:-https://veilguard.dev}"
POLAR_SERVER="${POLAR_SERVER:-production}"
UPLOAD_BUCKET="${UPLOAD_BUCKET:-${PROJECT}.appspot.com}"
WORKER_INVOKER_SA="${WORKER_INVOKER_SA:-veilguard-tasks@${PROJECT}.iam.gserviceaccount.com}"
# The GitHub App private key is mounted as a FILE (see --set-secrets below);
# github-app.ts readFileSync()s this path.
GITHUB_APP_PRIVATE_KEY_PATH="${GITHUB_APP_PRIVATE_KEY_PATH:-/secrets/github-app.pem}"

# Required — export these before running (no sensible default):
: "${WORKER_URL:?Set WORKER_URL to the deployed worker service URL (deploy the worker first)}"
: "${GITHUB_APP_ID:?Set GITHUB_APP_ID (GitHub App settings)}"
: "${GITHUB_APP_SLUG:?Set GITHUB_APP_SLUG (GitHub App settings)}"
: "${GITHUB_APP_CLIENT_ID:?Set GITHUB_APP_CLIENT_ID (GitHub App settings)}"
: "${SUPABASE_OAUTH_CLIENT_ID:?Set SUPABASE_OAUTH_CLIENT_ID (Supabase OAuth app)}"
: "${GUARD_MONTHLY:?Set GUARD_MONTHLY to the Polar Guard product id}"

# Build context = the directory containing BOTH veilguard-backend/ and
# veilguard-scanner/ (this script lives in veilguard-backend/scripts).
BACKEND_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONTEXT_DIR="$(cd "$BACKEND_DIR/.." && pwd)"

echo "→ Building $IMAGE (context: $CONTEXT_DIR)"
docker build -f "$BACKEND_DIR/functions/Dockerfile" -t "$IMAGE" "$CONTEXT_DIR"

echo "→ Pushing $IMAGE"
docker push "$IMAGE"

echo "→ Deploying Cloud Run service $SERVICE"
# Non-secret env vars go in --set-env-vars; secret values come from Secret
# Manager via --set-secrets so they never appear on the command line. The
# GitHub App private key is mounted as a FILE at $GITHUB_APP_PRIVATE_KEY_PATH.
gcloud run deploy "$SERVICE" \
  --project "$PROJECT" \
  --region "$REGION" \
  --image "$IMAGE" \
  --platform managed \
  --allow-unauthenticated \
  --min-instances 0 --max-instances 4 --timeout 120 \
  `# '|' delimiter (not the default comma, and not '@' — WORKER_INVOKER_SA is an email containing @)` \
  --set-env-vars "^|^GCLOUD_PROJECT=${PROJECT}|QUEUE_IMPL=cloudtasks|CLOUD_TASKS_LOCATION=${REGION}|CLOUD_TASKS_QUEUE=veilguard-scans|WORKER_URL=${WORKER_URL}|WORKER_INVOKER_SA=${WORKER_INVOKER_SA}|OAUTH_CALLBACK_BASE=${OAUTH_CALLBACK_BASE}|FRONTEND_URL=${FRONTEND_URL}|APP_BASE_URL=${APP_BASE_URL}|POLAR_SERVER=${POLAR_SERVER}|GUARD_MONTHLY=${GUARD_MONTHLY}|GITHUB_APP_ID=${GITHUB_APP_ID}|GITHUB_APP_SLUG=${GITHUB_APP_SLUG}|GITHUB_APP_CLIENT_ID=${GITHUB_APP_CLIENT_ID}|SUPABASE_OAUTH_CLIENT_ID=${SUPABASE_OAUTH_CLIENT_ID}|UPLOAD_BUCKET=${UPLOAD_BUCKET}|GITHUB_APP_PRIVATE_KEY_PATH=${GITHUB_APP_PRIVATE_KEY_PATH}" \
  --set-secrets "ENCRYPTION_KEY=ENCRYPTION_KEY:latest,SCHEDULE_SECRET=SCHEDULE_SECRET:latest,GITHUB_WEBHOOK_SECRET=GITHUB_WEBHOOK_SECRET:latest,RESEND_API_KEY=RESEND_API_KEY:latest,ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest,POLAR_ACCESS_TOKEN=POLAR_ACCESS_TOKEN:latest,POLAR_WEBHOOK_SECRET=POLAR_WEBHOOK_SECRET:latest,GITHUB_APP_CLIENT_SECRET=GITHUB_APP_CLIENT_SECRET:latest,SUPABASE_OAUTH_CLIENT_SECRET=SUPABASE_OAUTH_CLIENT_SECRET:latest,${GITHUB_APP_PRIVATE_KEY_PATH}=GITHUB_APP_PRIVATE_KEY:latest"

echo "✓ Deployed. Service URL:"
gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format='value(status.url)'
