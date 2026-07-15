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
  get usingEmulator(): boolean {
    return !!process.env.FIRESTORE_EMULATOR_HOST;
  },

  // Worker
  port: num('PORT', 8081),
  scanTimeoutMs: num('SCAN_TIMEOUT_MS', 120_000),

  // Cloud Tasks (prod)
  cloudTasksLocation: process.env.CLOUD_TASKS_LOCATION || 'us-central1',
  cloudTasksQueue: process.env.CLOUD_TASKS_QUEUE || 'veilguard-scans',
  workerUrl: process.env.WORKER_URL || '',
  workerInvokerSa: process.env.WORKER_INVOKER_SA || '',

  // createScan rate limit
  rateLimitWindowMs: num('RATE_LIMIT_WINDOW_MS', 60_000),
  rateLimitMax: num('RATE_LIMIT_MAX', 5),
} as const;
