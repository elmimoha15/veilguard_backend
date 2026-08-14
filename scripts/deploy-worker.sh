#!/usr/bin/env bash
#
# Deploy the Veilguard scan WORKER (worker/src/index.ts) to Cloud Run.
#
# The worker is a PRIVATE service (no unauthenticated access): only Cloud Tasks
# invokes it, via an OIDC token minted as the veilguard-tasks invoker SA. It
# exposes POST /runScan and runs the (bundled) scanner engine. Deploy this FIRST
# — the API needs the worker's URL (WORKER_URL) at deploy time.
#
# The image build needs the PARENT of both repos as its context (to pull in the
# local `veilguard-scanner` dependency), identical to deploy-api.sh.
#
# Prereqs: gcloud auth configured, Docker running, Artifact Registry repo exists,
# the invoker SA (veilguard-tasks@…) exists, and the secrets below are created in
# Secret Manager (see MONITORING.md / .env.example). The scanner must be built
# first: (cd ../veilguard-scanner && npm ci && npm run build).
#
# Usage (from the veilguard-backend dir):
#   PROJECT=veilguard-d6710 REGION=us-central1 \
#   GITHUB_APP_ID=… GITHUB_APP_SLUG=… GITHUB_APP_CLIENT_ID=… SUPABASE_OAUTH_CLIENT_ID=… \
#   bash scripts/deploy-worker.sh
set -euo pipefail

PROJECT="${PROJECT:-veilguard-d6710}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-veilguard-worker}"
REPO="${REPO:-veilguard}"          # Artifact Registry repository name
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/${SERVICE}:latest"

# ── Runtime config ──────────────────────────────────────────────────────────
APP_BASE_URL="${APP_BASE_URL:-https://veilguard.dev}"           # used in alert-email links
DEEP_SCAN_TIMEOUT_MS="${DEEP_SCAN_TIMEOUT_MS:-900000}"          # Cloud Run --timeout must be >= this
UPLOAD_BUCKET="${UPLOAD_BUCKET:-${PROJECT}.appspot.com}"
WORKER_INVOKER_SA="${WORKER_INVOKER_SA:-veilguard-tasks@${PROJECT}.iam.gserviceaccount.com}"
GITHUB_APP_PRIVATE_KEY_PATH="${GITHUB_APP_PRIVATE_KEY_PATH:-/secrets/github-app.pem}"

# Required — export before running (no sensible default):
: "${GITHUB_APP_ID:?Set GITHUB_APP_ID (GitHub App settings)}"
: "${GITHUB_APP_SLUG:?Set GITHUB_APP_SLUG (GitHub App settings)}"
: "${GITHUB_APP_CLIENT_ID:?Set GITHUB_APP_CLIENT_ID (GitHub App settings)}"
: "${SUPABASE_OAUTH_CLIENT_ID:?Set SUPABASE_OAUTH_CLIENT_ID (Supabase OAuth app)}"

# Build context = the directory containing BOTH veilguard-backend/ and
# veilguard-scanner/ (this script lives in veilguard-backend/scripts).
BACKEND_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONTEXT_DIR="$(cd "$BACKEND_DIR/.." && pwd)"

echo "→ Building $IMAGE (context: $CONTEXT_DIR)"
docker build -f "$BACKEND_DIR/worker/Dockerfile" -t "$IMAGE" "$CONTEXT_DIR"

echo "→ Pushing $IMAGE"
docker push "$IMAGE"

echo "→ Deploying PRIVATE Cloud Run service $SERVICE"
# --timeout 900 covers a deep scan (DEEP_SCAN_TIMEOUT_MS); --concurrency 1 keeps
# one heavy scan per instance; --max-instances caps runaway cost/retries.
gcloud run deploy "$SERVICE" \
  --project "$PROJECT" \
  --region "$REGION" \
  --image "$IMAGE" \
  --platform managed \
  --no-allow-unauthenticated \
  --timeout 900 --memory 2Gi --cpu 2 --concurrency 1 \
  --min-instances 0 --max-instances 3 \
  --set-env-vars "^@^GCLOUD_PROJECT=${PROJECT}@DEEP_SCAN_TIMEOUT_MS=${DEEP_SCAN_TIMEOUT_MS}@UPLOAD_BUCKET=${UPLOAD_BUCKET}@APP_BASE_URL=${APP_BASE_URL}@GITHUB_APP_ID=${GITHUB_APP_ID}@GITHUB_APP_SLUG=${GITHUB_APP_SLUG}@GITHUB_APP_CLIENT_ID=${GITHUB_APP_CLIENT_ID}@SUPABASE_OAUTH_CLIENT_ID=${SUPABASE_OAUTH_CLIENT_ID}@GITHUB_APP_PRIVATE_KEY_PATH=${GITHUB_APP_PRIVATE_KEY_PATH}" \
  --set-secrets "ENCRYPTION_KEY=ENCRYPTION_KEY:latest,ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest,RESEND_API_KEY=RESEND_API_KEY:latest,GITHUB_APP_CLIENT_SECRET=GITHUB_APP_CLIENT_SECRET:latest,SUPABASE_OAUTH_CLIENT_SECRET=SUPABASE_OAUTH_CLIENT_SECRET:latest,${GITHUB_APP_PRIVATE_KEY_PATH}=GITHUB_APP_PRIVATE_KEY:latest"

echo "→ Granting Cloud Tasks invoker (${WORKER_INVOKER_SA}) run.invoker on $SERVICE"
gcloud run services add-iam-policy-binding "$SERVICE" \
  --project "$PROJECT" --region "$REGION" \
  --member "serviceAccount:${WORKER_INVOKER_SA}" \
  --role roles/run.invoker

echo "✓ Deployed. WORKER_URL (feed this to deploy-api.sh):"
gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format='value(status.url)'
