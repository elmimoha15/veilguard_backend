# veilguard-backend

**Slices 2–5** of the Veilguard backend: the asynchronous **scan service** (Slice 2), the browser-facing **free-scan path** (Slice 3), **auth & accounts** (Slice 4), and **connected deep (white-box) scans** (Slice 5). A scan is triggered by an API call, run in the background by a worker, and streamed into Firestore live; a throwaway dev UI lets you sign up, connect a repo/DB, and watch real white-box findings appear against your account. No billing yet.

## Connected deep scans (Slice 5)

A signed-in user connects their **GitHub repo** and/or **Supabase project READ-ONLY**, and the worker runs the engine's **white-box** rules (hardcoded secrets, broken/missing RLS, SQL injection, unverified webhooks, insecure config, risky AI-rules files, dependency CVEs…) on their real code and DB policies — the highest-value findings.

**Security properties (non-negotiable, gate-checked):**
- **Read-only, least-privilege.** GitHub: `contents:read` + `metadata:read` on a **single repo** (a GitHub App install or a fine-grained PAT limited to that repo). Supabase: a **read-only** DB role / connection. No write/admin scopes, ever — we can't change your code even if we wanted to.
- **Source is never stored.** The worker fetches source into an **ephemeral tmp workspace** (`os.tmpdir()/veilguard-ws/{scanId}`), scans it, and **deletes it in a `finally` block** — guaranteed even on error/timeout. Only redacted **findings** are persisted; never file contents or DB rows.
- **Credentials are encrypted & client-unreadable.** Tokens/connection strings are AES-256-GCM encrypted (`shared/src/crypto.ts`) and stored only in `secrets/{uid}`, which `firestore.rules` **denies to all clients**. Non-secret metadata (which provider is connected) lives client-readable under `users/{uid}.connections`.
- **Revocable.** `POST /disconnect { provider }` deletes the encrypted credential + metadata; future deep scans for that source fail with a clear "not connected" error.
- **Owned & isolated.** Deep scans/findings inherit Slice-4 per-user isolation; a user can only scan their own connected resources.

**Endpoints (auth required):** `POST /connectGitHub`, `POST /connectSupabase`, `POST /connect/begin { provider }` + `GET /connect/{github,supabase}/callback` (OAuth), `POST /disconnect { provider }`, `POST /createDeepScan { github?, supabase?, url? }`. A deep scan can also include a URL, producing one unified grade over the whole app.

### Encryption approach

`ENCRYPTION_KEY` (env) is scrypt-derived to a 32-byte AES-256-GCM key. Ciphertext format `v1.<iv>.<tag>.<ct>` (base64url) is stored only server-side in `secrets/{uid}`. On the emulator a clearly-insecure dev key is used automatically; **production must set a real high-entropy `ENCRYPTION_KEY`** (Secret Manager / KMS). **Rotation:** deploy the new key alongside the old, re-encrypt every `secrets/*` blob (decrypt-with-old → encrypt-with-new), then retire the old key. (A KMS envelope-encryption upgrade is a good future step.)

### MOCK mode (local/testing)

Under the emulator (or `MOCK_CONNECTIONS=1`), the connect flows point at a **local fixture** instead of the real GitHub/Supabase APIs: `connectGitHub { repoPath }` and `connectSupabase { policiesPath }`. The worker copies the fixture into the ephemeral workspace exactly as a real clone would, so the full flow (fetch → scan → cleanup) is exercised without any real credentials. The gate uses the QuickCart repo fixture + a broken-RLS Supabase fixture.

### Supabase connect via OAuth (Slice 5b)

Real Supabase connections use the **Supabase Management API OAuth2 + PKCE** flow (client ID + secret in env / Secret Manager — the secret is **server-side only**, never sent to the client, never committed):

1. **begin** — `POST /connect/begin { provider: "supabase" }` (auth required) mints a single-use CSRF `state` **and a PKCE verifier** bound to the caller's uid (stored in `oauthStates/{state}`, denied to all clients) and returns the Supabase **authorize URL** (`https://api.supabase.com/v1/oauth/authorize?...&code_challenge=<S256>`). The browser is redirected there to **log in and approve** — a real Supabase consent screen.
2. **callback** — `GET /connect/supabase/callback?code&state` verifies the state (single-use, uid-bound, 10-min TTL), exchanges the code for tokens **server-side** (HTTP Basic `client_id:client_secret` + PKCE `code_verifier` → `POST /v1/oauth/token`), and stores the **access + refresh tokens AES-256-GCM-encrypted** in `secrets/{uid}` (client-denied). Only non-secret metadata (`projectRef`, `projectName`, `org`, `mode:'oauth'`) lands client-readable under `users/{uid}.connections.supabase`.
3. **scan** — at deep-scan time the worker decrypts the token, **refreshes it server-side if expired** (persisting the new token; a failed refresh flags `needsReconnect` and ends that scan cleanly, never crashing the worker), reads the project's schema + RLS policies **read-only** via the Management API, and feeds them to the engine's existing RLS analyzer. An optional **read-only anon-read probe** actively confirms which tables the anon role can read. Schema/policies live only in the ephemeral workspace and are discarded in `finally`.
4. **refresh / revoke** — expired tokens renew via the refresh token; `POST /disconnect { provider: "supabase" }` deletes the encrypted token + metadata (Supabase exposes no token-revocation endpoint, so deleting our only copy is the revoke; the user can also revoke the app in their Supabase dashboard), so a later Supabase scan fails with a clear "not connected — reconnect Supabase".

**Read-only, least-privilege:** Supabase OAuth2 **scopes are configured on the OAuth app** (the `scope` query param is deprecated — set your app to read-only in the Supabase dashboard). We additionally **self-restrict to read-only Management API calls**, never a write/admin endpoint. Env vars: `SUPABASE_OAUTH_CLIENT_ID`, `SUPABASE_OAUTH_CLIENT_SECRET`, `OAUTH_CALLBACK_BASE` (see `.env.example`).

**Running it for real (locally):** `npm run dev:all` sets `MOCK_CONNECTIONS=0`, so clicking **Connect Supabase** in the dev UI redirects to the real Supabase login. Because Supabase must reach your callback, `OAUTH_CALLBACK_BASE` points at a public tunnel (e.g. ngrok) and you must register **`<OAUTH_CALLBACK_BASE>/connect/supabase/callback`** as an authorized redirect URL in your Supabase OAuth app. Open the dev UI *through* that tunnel URL so the post-consent redirect lands back on it. `MOCK_CONNECTIONS` controls the seam: unset → mock under the emulator (so `npm test` / `npm run gate:supabase` run credential-free against the broken-RLS fixture); `=0` → real OAuth even while Firestore is emulated; `=1` → force mock.

## Auth & accounts (Slice 4)

## Auth & accounts (Slice 4)

- **Sign-in** via the Firebase **Auth emulator**: email/password, Google, and GitHub (GitHub is wired for Slice 5's repo access but requests **basic profile only** — no repo scopes yet).
- On the first authenticated backend call (`POST /me`, or an authenticated `createScan`), the server idempotently creates `users/{uid}` = `{ uid, email, displayName, createdAt, plan: 'free', provider, connections: {}, alertEmail }`. `plan` is server-controlled — a `getPlan(uid)` helper is ready for Slice 6 to flip fixes on. Nothing is gated on it yet.
- **Owned scans**: an authenticated `createScan` stamps `ownerUid = uid`; anonymous (no token) scans keep `ownerUid = null` (the free public path, unchanged). Signed-in users can query **their own** scans (`where ownerUid == uid`), newest first.
- **Claim flow**: ran a free scan before signing up? `POST /claimScan { scanId }` (auth required) assigns an ownerless scan to you. Already-owned scans can't be re-claimed (409); unknown ids 404.
- **Token verification**: authenticated endpoints (`/me`, `/claimScan`) reject missing/invalid/expired ID tokens with 401 (Admin `verifyIdToken`). `createScan` accepts no-token (anonymous) but rejects a *present-but-invalid* token with 401.

### Isolation & fix-locking (rules-enforced)

`firestore.rules` is the source of truth (tested via the client SDK, not Admin):
- `users/{uid}` — a user reads/writes only their own doc, and **cannot change `plan`** (no self-upgrade); never enumerable.
- `scans/{id}` — `get` if `ownerUid == null` (anon, public-by-id) or `request.auth.uid == ownerUid`; `list` **only** where `ownerUid == request.auth.uid` (you can list only your own; anon scans aren't enumerable, others' aren't readable); no client writes.
- `findings` inherit the parent scan's readability; `findings/{fid}/private/fix` (`fix`/`fixPrompt`) is **denied to all clients** — even an authenticated owner on the free plan can't read it. The paywall stays enforced at the data layer until Slice 6.

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

`dev-ui/` is a **throwaway** dev harness — **not the product frontend** (the designed frontend integrates much later). It's a single unstyled page (`index.html` + `app.js`) that loads Firebase from the gstatic CDN and, against the emulator: signs up / logs in (email + Google + GitHub) / logs out, calls `POST /createScan` (with the ID token when signed in), streams findings live with locked-fix placeholders, shows your **my-scans** list, and offers a **claim** button. Served by the local dev-server (same origin, no build step).

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
npm test              # vitest integration suite against the emulator (auto-starts it)
npm run gate          # Slice-5 connected-deep-scan gate, prints GATE RESULTS (A–I)
npm run gate:supabase # Slice-5b Supabase OAuth connector gate, prints GATE RESULTS (A–J)
npm run typecheck     # tsc --noEmit
npm run build         # tsc -p tsconfig.build.json → dist/
```

`npm test`, `npm run gate`, and `npm run gate:supabase` each wrap the command in `firebase emulators:exec --only firestore,auth`, which starts the emulator, sets `FIRESTORE_EMULATOR_HOST`/`FIREBASE_AUTH_EMULATOR_HOST` for the child, and tears down afterwards.

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
`scans/{scanId}/findings/{findingId}`: the engine `Finding` **minus** `fix`/`fixPrompt` (those live in the rules-denied `findings/{fid}/private/fix`). A scan also has `type: 'url' | 'deep'` and, for deep scans, `ownerUid` + `sources`. `secrets/{uid}` holds encrypted credentials, denied to all clients.

## Before first deploy

- **`ENCRYPTION_KEY`** — set a real high-entropy secret from Secret Manager/KMS (the emulator dev key is insecure). Plan key rotation (re-encrypt `secrets/*`).
- **GitHub** — create a **GitHub App** (or use fine-grained PATs) requesting **Contents: Read-only + Metadata: Read-only on a single repo**; wire the install/OAuth callback into `connectGitHub` (replace MOCK mode). No `repo` (write) or org scopes.
- **Supabase** — register a **Supabase Management API OAuth app**, set `SUPABASE_OAUTH_CLIENT_ID` / `SUPABASE_OAUTH_CLIENT_SECRET` (secret server-side only) and `OAUTH_CALLBACK_BASE`; the `/connect/begin` → `/connect/supabase/callback` flow reads schema + RLS policies **read-only** via the Management API. Requested scopes: `projects:read database:read secrets:read` — no write/admin, ever. (MOCK mode wires into `connectSupabase { policiesPath }` for credential-free local runs.)
- **Queue/worker** — set `QUEUE_IMPL=cloudtasks`, `WORKER_URL`, the Cloud Tasks queue, and deploy the worker image (Cloud Run). Ensure the worker's tmp dir is ephemeral and sized for `DEEP_SCAN_MAX_BYTES`.
- **`git`** must be on the worker image for real GitHub clones (the base image has it; mock mode doesn't need it).

## DEFERRED (carried forward)

From Slice 1, still deferred until a later slice: deeper detection rules — full **active black-box probes** (GraphQL introspection, `alg:none` JWT forgery, `x-middleware-subrequest` bypass, source-map/admin-endpoint exposure), **IDOR/BOLA data-flow** + Server Action ownership analysis, **SSRF**, **prototype pollution**, NoSQL injection, and consuming the authored `semgrep-rules/*.yaml`. Slices 2–5 add no new detection rules; they wrap the engine as a service and feed it real (free URL, then connected repo/DB) input.
