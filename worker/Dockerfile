# Veilguard scan worker (Cloud Run).
#
# The scanner engine is native-first and needs no runtime deps of its own, but we
# DO ship two pinned, checksum-verified security scanners it merges in on deep /
# upload scans: gitleaks (secrets + git history) and osv-scanner (dependency
# CVEs). Both are small static Go binaries. (No python/semgrep/JVM.)
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

# ---- tools stage: fetch + checksum-verify the pinned security scanners ----
# Done in a throwaway alpine stage so curl never lands in the runtime image. The
# binaries are static, so they run fine when copied into the node:20-slim runtime.
FROM alpine:3.20 AS tools
RUN apk add --no-cache curl
# Pin EXACT versions + SHA256 (from each release's published checksums). Bump both
# together when upgrading.
ARG GITLEAKS_VERSION=8.30.1
ARG GITLEAKS_SHA256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
ARG OSV_VERSION=2.6.0
ARG OSV_SHA256=ca69b3d3cd08f889a49dc0a383122f71cc528b83803671df5fd874d97485b108
RUN set -eux; \
    curl -fsSL -o /tmp/gitleaks.tar.gz \
      "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"; \
    echo "${GITLEAKS_SHA256}  /tmp/gitleaks.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/gitleaks.tar.gz -C /usr/local/bin gitleaks; \
    chmod +x /usr/local/bin/gitleaks; \
    curl -fsSL -o /usr/local/bin/osv-scanner \
      "https://github.com/google/osv-scanner/releases/download/v${OSV_VERSION}/osv-scanner_linux_amd64"; \
    echo "${OSV_SHA256}  /usr/local/bin/osv-scanner" | sha256sum -c -; \
    chmod +x /usr/local/bin/osv-scanner; \
    /usr/local/bin/gitleaks version; \
    /usr/local/bin/osv-scanner --version

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

# Pinned, checksum-verified security scanners (see tools stage). The scanner
# detects them on PATH and merges their findings on deep/upload scans.
COPY --from=tools /usr/local/bin/gitleaks /usr/local/bin/osv-scanner /usr/local/bin/

# Cloud Run injects PORT; default matches config.ts.
ENV PORT=8081
EXPOSE 8081
USER node
CMD ["node", "dist/worker/src/index.js"]
