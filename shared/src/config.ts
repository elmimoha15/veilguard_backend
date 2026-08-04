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

  // createScan rate limit
  rateLimitWindowMs: num('RATE_LIMIT_WINDOW_MS', 60_000),
  rateLimitMax: num('RATE_LIMIT_MAX', 5),

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
  // From addresses live on the verified sending subdomain (send.veilguard.dev).
  get alertFromEmail(): string { return process.env.ALERT_FROM_EMAIL || 'Veilguard <alerts@send.veilguard.dev>'; },
  get emailFrom(): string { return process.env.EMAIL_FROM || 'Veilguard <hello@send.veilguard.dev>'; },
  get marketingFromEmail(): string { return process.env.EMAIL_MARKETING_FROM || 'Veilguard <news@send.veilguard.dev>'; },
  get emailReplyTo(): string { return process.env.EMAIL_REPLY_TO || 'support@veilguard.dev'; },
  // Base URL the app is served from — used in email links + Admin action-code URLs.
  get appBaseUrl(): string { return process.env.APP_BASE_URL || this.frontendUrl || 'https://veilguard.dev'; },

  // DEV-ONLY fake-paid preview. When on (AND on the emulator), a dev endpoint
  // returns fix/fixPrompt so the frontend can preview the unlocked UI before
  // real billing. NEVER enable in production — the real paywall is unchanged.
  get devFakePaid(): boolean {
    return (process.env.DEV_FAKE_PAID === '1' || process.env.DEV_FAKE_PAID === 'true') && this.usingEmulator;
  },

  // --- Billing (Slice 6) ---
  // FAKE billing: lets a signed-in user set their own plan via POST /billing/confirm
  // WITHOUT payment, so free↔paid can be tested end-to-end. NOT emulator-gated (so it
  // works on the real dev project). MUST stay unset in production — the real
  // plan-setter there is the Polar webhook.
  get fakeBilling(): boolean {
    return process.env.FAKE_BILLING === '1' || process.env.FAKE_BILLING === 'true';
  },
  // Polar webhook secret (verifies the signature on POST /polarWebhook). Empty →
  // the webhook is inert (returns ignored). Emulator dev-fallback for local tests.
  get polarWebhookSecret(): string {
    return process.env.POLAR_WEBHOOK_SECRET || (this.usingEmulator ? 'dev-emulator-polar-secret' : '');
  },
  get polarAccessToken(): string { return process.env.POLAR_ACCESS_TOKEN || ''; },
  get polarConfigured(): boolean { return !!this.polarAccessToken && !!this.polarWebhookSecret; },

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
} as const;
