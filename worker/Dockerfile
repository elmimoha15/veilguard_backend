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

# Cloud Run injects PORT; default matches config.ts.
ENV PORT=8081
EXPOSE 8081
USER node
CMD ["node", "dist/worker/src/index.js"]
