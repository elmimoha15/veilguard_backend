# Veilguard scan worker (Cloud Run).
#
# The scanner engine is native-first — NO python/semgrep/gitleaks/osv or JVM are
# needed at runtime — so this image stays small and boots fast.
#
# IMPORTANT: build with the PARENT of both repos as the context, so the local
# `veilguard-scanner` dependency is available:
#
#   docker build -f veilguard-backend/worker/Dockerfile -t veilguard-worker .
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

# `git` is required at runtime for real GitHub clones during deep scans (the
# slim base image doesn't ship it); ca-certificates for HTTPS to GitHub/Supabase.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /veilguard-scanner /veilguard-scanner

# Cloud Run injects PORT; default matches config.ts.
ENV PORT=8081
EXPOSE 8081
USER node
CMD ["node", "dist/worker/src/index.js"]
