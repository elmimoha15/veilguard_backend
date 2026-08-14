# Veilguard API service (Cloud Run).
#
# Hosts the public Express app (functions/src/index.ts → createApiApp()), which
# includes the monitoring endpoints POST /runSchedules and POST /githubWebhook.
# The worker (worker/Dockerfile) is a SEPARATE Cloud Run service that only runs
# scans; this image serves the API that enqueues them.
#
# IMPORTANT: build with the PARENT of both repos as the context, so the local
# `veilguard-scanner` dependency is available (identical constraint to the
# worker image):
#
#   docker build -f veilguard-backend/functions/Dockerfile -t veilguard-api .
#
# (run from the directory that contains both veilguard-backend/ and
#  veilguard-scanner/).

# ---- build stage ----
FROM node:20-slim AS build
WORKDIR /app

# Bring in the local scanner dependency (built dist is published via its files).
COPY veilguard-scanner /veilguard-scanner
# The scanner is a file: dep consumed via its built dist; install its OWN runtime
# deps (zod, etc.) so the tsc compile AND runtime can resolve them. Without this,
# the backend's zod-inferred types collapse to {} and the scanner fails at runtime.
RUN cd /veilguard-scanner && npm ci --omit=dev --no-audit --no-fund
COPY veilguard-backend/package.json veilguard-backend/package-lock.json veilguard-backend/tsconfig.json veilguard-backend/tsconfig.build.json ./
COPY veilguard-backend/shared ./shared
COPY veilguard-backend/worker ./worker
COPY veilguard-backend/functions ./functions

# `npm ci` installs the EXACT locked versions (incl. devDependencies: @types/*,
# zod, typescript) so the tsc compile resolves types identically to local; then
# prune to production-only deps for the runtime stage. (A bare `npm install`
# without the lockfile drifts dependency versions and breaks type resolution.)
RUN npm ci --no-audit --no-fund \
  && npx tsc -p tsconfig.build.json \
  && npm prune --omit=dev

# ---- runtime stage ----
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /veilguard-scanner /veilguard-scanner

# Cloud Run injects PORT; index.ts reads API_PORT || PORT (default 8080).
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "dist/functions/src/index.js"]
