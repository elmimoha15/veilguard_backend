# veilguard-backend

**Slices 2–3** of the Veilguard backend: the asynchronous **scan service** (Slice 2) plus the browser-facing **free-scan path** (Slice 3). A scan is triggered by an API call, run in the background by a worker, and streamed into Firestore live; a throwaway dev UI lets you paste a URL and watch findings appear. No user auth or billing yet.

```
POST /createScan ──► scans/{id} (queued) ──► Queue ──► Worker /runScan
                                                          │
                                        streams findings ▼
                       scans/{id}/findings/*  +  scans/{id}.progress
                                                          │
                                                          ▼
                                      scans/{id} (done: grade + counts)
```

- **API** (`functions/`): thin, fast `POST /createScan`. Validates, creates a `queued` doc, enqueues, returns `{ scanId }`. Never runs the scan.
- **Queue** (`shared/src/queue.ts`): `Queue.enqueue(job)` with two impls chosen by env — `InMemoryQueue` (local/tests, calls the worker in-process) and `CloudTasksQueue` (prod, HTTP task with OIDC).
- **Worker** (`worker/`): Cloud Run service, `POST /runScan`. Claims the scan (idempotent), runs the engine, **streams each finding into Firestore as it's produced**, updates `progress`, then marks `done` (or `error`). Wrapped in a timeout; never left stuck `running`.
- **Firestore** (`shared/src/firestore.ts`): `scans/{id}` + `scans/{id}/findings/{findingId}`. Finding doc ids are the engine's deterministic hash, so retries overwrite instead of duplicating.

The scanner engine is a **local file dependency** (`"veilguard-scanner": "file:../veilguard-scanner"`) — this service never forks detection logic.

## Prerequisites

- Node 18+.
- The Firestore emulator needs **Java**. This repo provisions a portable JRE at `.jre/` (gitignored); the npm scripts put it on `PATH` automatically. If you have a system JDK you can delete `.jre/` and it'll use that.
- `firebase-tools` on your `PATH` (the scripts call `firebase`).

## The free-scan path (Slice 3)

The public flow, as the browser hits it:

```
[dev-ui]  paste URL → POST /createScan  ──►  scans/{id} (queued)
                                              │  (guard: http/https only,
                                              │   no localhost/private IPs,
                                              │   url-only — repos need a
                                              │   code connection, Slice 5)
   client SDK subscribes to scans/{id}  ◄─────┘  worker streams findings
   + scans/{id}/findings  (rules-enforced)      grade shown when done
```

**Fix-locking (the paywall, enforced at the data layer — not just the UI).**
Each finding is split when written:

- `scans/{id}/findings/{fid}` — public fields (title, whyItMatters, severity, category, location). Client-readable.
- `scans/{id}/findings/{fid}/private/fix` — `{ fix, fixPrompt }`. **`firestore.rules` denies this to all clients**; only the Admin SDK (server) can read it.

So an unauthenticated client (or anyone poking the browser's network tab) literally **cannot retrieve the fix content** — it isn't in the readable document and the private doc is denied. The dev-ui shows a `🔒 Fix locked — upgrade to unlock` placeholder. (Actual payment/unlock lands in Slice 6.) We chose option (b)+(a): omit the fields from the public doc **and** keep them in a rules-denied `private` subcollection.

**No enumeration.** `firestore.rules` allows `get` on a known `scans/{id}` and `get/list` on its `findings`, but denies `list` on the `scans` collection — so a client can read a scan it has the (unguessable) id for, but cannot enumerate others' scans.

## Throwaway dev UI

`dev-ui/` is a **throwaway** dev harness — **not the product frontend** (the designed frontend integrates much later). It's a single unstyled page (`index.html` + `app.js`) that loads Firebase from the gstatic CDN, calls `POST /createScan`, and subscribes to the emulator to stream findings live with locked-fix placeholders. It's served by the local dev-server (same origin, no build step).

```bash
npm install
npm run dev:all
# → open http://127.0.0.1:8787  (boots emulator + dev-server + in-process worker)
#   paste a URL (e.g. https://example.com) and click "Run free scan"
#   or auto-run:  http://127.0.0.1:8787/?auto=https://example.com
```

## Run the service pipeline directly

```bash
# Boots the Firestore emulator, wires an in-memory queue to the in-process
# worker, scans the QuickCart fixture (repo path — internal pipeline), tails live.
npm run trigger
npm run trigger -- https://example.com
```

Running pieces separately:

```bash
# Terminal 1 — emulator (Firestore on :8080).
# `npm run emulators` runs `firebase emulators:start --only firestore` with the
# bundled JRE on PATH; you can also invoke `firebase emulators:start` directly.
npm run emulators

# Terminal 2 — the worker (Cloud Run service) on :8081
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm run worker

# Then POST a scan (createScan can run as its own service too — see functions/src/index.ts)
```

## Tests & gate

```bash
npm test          # vitest integration suite against the emulator (auto-starts it)
npm run gate      # runs the Slice-2 checklist and prints GATE RESULTS (A–G)
npm run typecheck # tsc --noEmit
npm run build     # tsc -p tsconfig.build.json → dist/
```

Both `npm test` and `npm run gate` wrap the command in `firebase emulators:exec --only firestore`, which starts the emulator, sets `FIRESTORE_EMULATOR_HOST` for the child, and tears down afterwards.

## The worker image

`worker/Dockerfile` is a lean multi-stage `node:20-slim` build (no Python/Java/Go — the engine is native-first). Build it from the **parent** of both repos so the local scanner dependency is in context:

```bash
# from the directory containing veilguard-backend/ and veilguard-scanner/
docker build -f veilguard-backend/worker/Dockerfile -t veilguard-worker .
```

> Note: the Docker build is not run in this dev environment (no Docker daemon). The Dockerfile is written and reviewed; run the command above on a machine with Docker / in CI to produce the image.

## Configuration

See `.env.example`. Key vars: `QUEUE_IMPL` (`memory` | `cloudtasks`), `GCLOUD_PROJECT`, `PORT`, `SCAN_TIMEOUT_MS`, and the `CLOUD_TASKS_*` / `WORKER_URL` set for production. No secrets are committed.

## Data model

`scans/{scanId}`:
```jsonc
{ "id", "target": { "type": "url|repo", "value" },
  "status": "queued|running|done|error",
  "grade?", "score?", "counts?", "error?",
  "createdAt", "startedAt?", "finishedAt?",
  "progress?": { "done", "total", "phase" } }
```
`scans/{scanId}/findings/{findingId}`: the engine `Finding` (ruleId, category, severity, cwe, owasp, title, whyItMatters, evidence, location, fix, fixPrompt, confidence, mode). Fixes/fixPrompt are stored now; **paywall gating arrives in Slice 6.**

## DEFERRED (carried forward)

From Slice 1, still deferred until a later slice: deeper detection rules — full **active black-box probes** (GraphQL introspection, `alg:none` JWT forgery, `x-middleware-subrequest` bypass, source-map/admin-endpoint exposure), **IDOR/BOLA data-flow** + Server Action ownership analysis, **SSRF**, **prototype pollution**, NoSQL injection, and consuming the authored `semgrep-rules/*.yaml`. Slice 2 adds no new detection; it only wraps the engine as a service.
