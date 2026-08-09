/** Central, typed view of the environment. Read once, reuse everywhere. */

function num(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  projectId: process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'demo-veilguard',
  queueImpl: (process.env.QUEUE_IMPL || 'memory') as 'memory' | 'cloudtasks',

  /** Present (and set by `firebase emulators:exec`) when running on the emulator. */
  firestoreEmulatorHost: process.env.FIRESTORE_EMULATOR_HOST,
  authEmulatorHost: process.env.FIREBASE_AUTH_EMULATOR_HOST,
  get usingEmulator(): boolean {
    return !!process.env.FIRESTORE_EMULATOR_HOST;
  },

  // Worker
  port: num('PORT', 8081),
  // URL (black-box) scans should be quick — a slow public site fails fast.
  scanTimeoutMs: num('SCAN_TIMEOUT_MS', 120_000),
  // Deep/upload (white-box) scans clone + parse a whole codebase, so they get a
  // much longer budget. In prod the Cloud Run worker's request timeout must be
  // >= this value.
  deepScanTimeoutMs: num('DEEP_SCAN_TIMEOUT_MS', 900_000), // 15 min

  // Cloud Tasks (prod)
  cloudTasksLocation: process.env.CLOUD_TASKS_LOCATION || 'us-central1',
  cloudTasksQueue: process.env.CLOUD_TASKS_QUEUE || 'veilguard-scans',
  workerUrl: process.env.WORKER_URL || '',
  workerInvokerSa: process.env.WORKER_INVOKER_SA || '',

  // createScan rate limit — per (IP,target) pair.
  rateLimitWindowMs: num('RATE_LIMIT_WINDOW_MS', 60_000),
  rateLimitMax: num('RATE_LIMIT_MAX', 5),
  // Abuse #1: a second, broader cap on the free URL scan keyed on IP ALONE, so
  // one IP can't spray unlimited *distinct* targets (5 each). In-memory/per-
  // process like the base limiter — a distributed limiter is future work.
  freeScanIpWindowMs: num('FREE_SCAN_IP_WINDOW_MS', 60_000),
  freeScanIpMax: num('FREE_SCAN_IP_MAX', 20),

  // Local-dev / test seam: allow localhost & private-IP scan targets on the
  // public path. Default false (secure). Never enable in production.
  allowPrivateTargets: process.env.ALLOW_PRIVATE_TARGETS === '1' || process.env.ALLOW_PRIVATE_TARGETS === 'true',

  // Combined local dev-server (serves the throwaway UI + createScan + worker).
  devServerPort: num('DEV_SERVER_PORT', 8787),

  // --- Slice 5: connected deep scans ---
  // Credential-encryption key. In prod set a real high-entropy secret; on the
  // emulator we fall back to a clearly-insecure dev key so local runs work.
  get encryptionKey(): string {
    return process.env.ENCRYPTION_KEY || (this.usingEmulator ? 'dev-insecure-emulator-key-do-not-use-in-prod' : '');
  },
  // MOCK connection providers: connect points at a local fixture instead of the
  // real GitHub/Supabase APIs — this exists ONLY so the automated test suite can
  // run without real OAuth credentials. It is NOT tied to the Firestore emulator:
  // real OAuth works fine while Firestore is emulated.
  //   MOCK_CONNECTIONS=0/false → force REAL OAuth (dev/prod, even on the emulator)
  //   MOCK_CONNECTIONS=1/true  → force MOCK
  //   unset                    → MOCK under the emulator (so `npm test`/gates are
  //                              credential-free); REAL otherwise.
  get mockConnections(): boolean {
    const v = (process.env.MOCK_CONNECTIONS || '').toLowerCase();
    if (v === '0' || v === 'false' || v === 'off') return false;
    if (v === '1' || v === 'true' || v === 'on') return true;
    return this.usingEmulator;
  },
  // Ephemeral workspace caps for deep scans.
  deepScanMaxBytes: num('DEEP_SCAN_MAX_BYTES', 200 * 1024 * 1024), // 200MB

  // --- Upload scans (Pro-only folder/zip upload) ---
  // Max size of the uploaded .zip accepted by POST /createUploadScan. The
  // extracted workspace is separately bounded by deepScanMaxBytes.
  uploadMaxBytes: num('UPLOAD_MAX_BYTES', 40 * 1024 * 1024), // 40MB zip
  // Max number of entries in an uploaded zip (zip-bomb guard).
  uploadMaxEntries: num('UPLOAD_MAX_ENTRIES', 20_000),
  // GCS bucket used to STAGE an uploaded zip between the API and the worker when
  // they don't share a filesystem (multi-instance prod, QUEUE_IMPL=cloudtasks).
  // Empty → default bucket `${projectId}.appspot.com`. Unused by LocalFsStaging.
  get uploadBucket(): string { return process.env.UPLOAD_BUCKET || `${this.projectId}.appspot.com`; },

  // --- Slice 7: monitoring (scheduled + push-triggered re-scans) ---
  // Max monitored apps enqueued per scheduler tick (stops a stampede).
  monitorMaxPerRun: num('MONITOR_MAX_PER_RUN', 50),
  // Ignore repeated pushes to the same repo within this window (debounce).
  monitorPushDebounceMs: num('MONITOR_PUSH_DEBOUNCE_MS', 3 * 60_000),
  // Shared secret Cloud Scheduler sends (header x-veilguard-cron) to call
  // /runSchedules. On the emulator a dev value is accepted so local runs work.
  get scheduleSecret(): string {
    return process.env.SCHEDULE_SECRET || (this.usingEmulator ? 'dev-emulator-cron-secret' : '');
  },
  // GitHub App webhook secret used to verify X-Hub-Signature-256. On the emulator
  // a dev value is used so the webhook test can sign requests without real setup.
  get githubWebhookSecret(): string {
    return process.env.GITHUB_WEBHOOK_SECRET || (this.usingEmulator ? 'dev-emulator-webhook-secret' : '');
  },
  // --- Email alerts (Slice 7) --- when RESEND_API_KEY is set, real alert emails
  // are sent via Resend; otherwise the console transport is used (tests/dev).
  get resendApiKey(): string { return process.env.RESEND_API_KEY || ''; },
  // From addresses live on the verified sending domain (veilguard.dev). NOTE:
  // Resend only accepts a From: on the VERIFIED domain itself — the `send.`
  // label in the DNS records is just the SPF return-path, not a sending domain.
  get alertFromEmail(): string { return process.env.ALERT_FROM_EMAIL || 'Veilguard <alerts@veilguard.dev>'; },
  get emailFrom(): string { return process.env.EMAIL_FROM || 'Veilguard <hello@veilguard.dev>'; },
  get marketingFromEmail(): string { return process.env.EMAIL_MARKETING_FROM || 'Veilguard <news@veilguard.dev>'; },
  get emailReplyTo(): string { return process.env.EMAIL_REPLY_TO || 'support@veilguard.dev'; },
  // Base URL the app is served from — used in email links + Admin action-code URLs.
  get appBaseUrl(): string { return process.env.APP_BASE_URL || this.frontendUrl || 'https://veilguard.dev'; },

  // --- Billing (Slice 6, Polar) — real payment gating. No fake/dev paths. ---
  // Polar webhook secret (standard-webhooks; verifies POST /polarWebhook). Empty →
  // the webhook is inert (returns ignored). Emulator dev-fallback for local tests.
  get polarWebhookSecret(): string {
    return process.env.POLAR_WEBHOOK_SECRET || (this.usingEmulator ? 'dev-emulator-polar-secret' : '');
  },
  get polarAccessToken(): string { return process.env.POLAR_ACCESS_TOKEN || ''; },
  get polarConfigured(): boolean { return !!this.polarAccessToken && !!this.polarWebhookSecret; },
  // 'sandbox' for testing, 'production' when live. Defaults to sandbox off-prod.
  get polarServer(): 'sandbox' | 'production' {
    return process.env.POLAR_SERVER === 'production' ? 'production' : 'sandbox';
  },
  // Per-request timeout for Polar API calls. Bounded so a network hiccup /
  // unreachable Polar fails fast instead of hanging (the SDK otherwise retries
  // connection errors with backoff for a long time).
  get polarTimeoutMs(): number { return num('POLAR_TIMEOUT_MS', 8000); },
  // Polar product IDs → plan mapping. Guard (recurring). Annual optional.
  get guardProductId(): string { return process.env.GUARD_MONTHLY || ''; },
  get guardAnnualProductId(): string { return process.env.GUARD_ANNUAL || ''; },
  /** All product IDs that map to the Guard plan (monthly + optional annual). */
  get guardProductIds(): string[] { return [this.guardProductId, this.guardAnnualProductId].filter(Boolean); },

  // --- Real connections (OAuth) --- read lazily so a .env loaded at startup is
  // picked up. A provider is "configured" only when its real credentials exist;
  // otherwise the mock path is used (keeps CI/tests credential-free).
  get oauthCallbackBase(): string { return process.env.OAUTH_CALLBACK_BASE || ''; },
  get frontendUrl(): string { return process.env.FRONTEND_URL || 'http://localhost:3000'; },
  get githubAppId(): string { return process.env.GITHUB_APP_ID || ''; },
  get githubAppSlug(): string { return process.env.GITHUB_APP_SLUG || ''; },
  get githubClientId(): string { return process.env.GITHUB_APP_CLIENT_ID || ''; },
  get githubClientSecret(): string { return process.env.GITHUB_APP_CLIENT_SECRET || ''; },
  get githubPrivateKeyPath(): string { return process.env.GITHUB_APP_PRIVATE_KEY_PATH || ''; },
  get githubConfigured(): boolean {
    return !!(this.githubAppId && this.githubAppSlug && this.githubPrivateKeyPath && this.oauthCallbackBase);
  },

  // --- Supabase Management API OAuth (Slice 5b) ---
  // client_id is a public identifier (it appears in the authorize URL by design);
  // client_secret is confidential — server-side only, never sent to the client.
  get supabaseClientId(): string { return process.env.SUPABASE_OAUTH_CLIENT_ID || ''; },
  get supabaseClientSecret(): string { return process.env.SUPABASE_OAUTH_CLIENT_SECRET || ''; },
  get supabaseConfigured(): boolean {
    return !!(this.supabaseClientId && this.supabaseClientSecret && this.oauthCallbackBase);
  },
  // In MOCK mode the OAuth callback points the connection at this local fixture
  // (broken-RLS .sql) instead of doing a real Supabase Management API round-trip.
  get mockSupabasePoliciesPath(): string {
    return process.env.MOCK_SUPABASE_POLICIES_PATH || 'test-fixtures/supabase-broken-rls';
  },

  // --- Slice 8: per-plan caps (server-enforced) + Claude-tailored fixes ---
  // Caps are one place so a future higher/UNLIMITED tier is a one-line change.
  // A single monthly SCAN quota per plan — every scan type (URL, deep, upload,
  // monitoring re-scan) draws from it. Apps are unlimited. Getters so a test /
  // deploy env can tune them without a rebuild.
  get freeMaxScansPerMonth(): number { return num('FREE_MAX_SCANS_PER_MONTH', 2); },
  get guardMaxScansPerMonth(): number { return num('GUARD_MAX_SCANS_PER_MONTH', 30); },
  // AI-fix cost guard: at most N findings per scan get a Claude fix (the rest use
  // the engine's canned fix), and at most M Claude calls per user per month.
  get aiFixMaxPerScan(): number { return num('AI_FIX_MAX_PER_SCAN', 8); },
  get aiFixMaxPerMonth(): number { return num('AI_FIX_MAX_PER_MONTH', 200); },
  // Anthropic API — server-only. Unset → AI fixes are skipped entirely (canned
  // fixes ship), so no key means no behavior change and no network in tests.
  get anthropicApiKey(): string { return process.env.ANTHROPIC_API_KEY || ''; },
  get aiFixEnabled(): boolean { return !!this.anthropicApiKey; },
  // Cheap/fast default; escalate to a stronger model only when the cheap one's
  // output fails validation (see claude-fix.ts).
  aiFixModel: process.env.AI_FIX_MODEL || 'claude-haiku-4-5',
  aiFixEscalateModel: process.env.AI_FIX_ESCALATE_MODEL || 'claude-sonnet-5',
} as const;
