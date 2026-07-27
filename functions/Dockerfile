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
COPY veilguard-backend/package.json veilguard-backend/tsconfig.json veilguard-backend/tsconfig.build.json ./
COPY veilguard-backend/shared ./shared
COPY veilguard-backend/worker ./worker
COPY veilguard-backend/functions ./functions

RUN npm install --omit=dev --no-audit --no-fund \
  && npm install --no-save typescript@5 \
  && npx tsc -p tsconfig.build.json

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
