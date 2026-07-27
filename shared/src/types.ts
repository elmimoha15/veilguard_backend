import { z } from 'zod';
import { FindingSchema, TargetSchema, CountsSchema, GradeSchema } from 'veilguard-scanner';
import type { Finding, ScanReport, ScanProgress, Target } from 'veilguard-scanner';

export type { Finding, ScanReport, ScanProgress, Target };
export { FindingSchema };

export type ScanStatus = 'queued' | 'running' | 'done' | 'error';
export type Plan = 'free' | 'guard' | 'fixpack';

/** Input accepted by POST /createScan. */
export const CreateScanInputSchema = z.object({
  target: TargetSchema,
});
export type CreateScanInput = z.infer<typeof CreateScanInputSchema>;

/** The `users/{uid}` document. Created on first authenticated call. */
export const UserDocSchema = z.object({
  uid: z.string(),
  email: z.string().optional(),
  displayName: z.string().optional(),
  createdAt: z.string(),
  // 'free' by default; only the server (Slice 6 billing) may change it.
  plan: z.enum(['free', 'guard', 'fixpack']),
  provider: z.string().optional(),
  // Reserved for Slice 5 (GitHub/Supabase). Empty for now.
  connections: z.record(z.string(), z.unknown()).default({}),
  alertEmail: z.string().optional(),
  // New users start un-onboarded; the client flips this after onboarding.
  onboarded: z.boolean().default(false),
});
export type UserDoc = z.infer<typeof UserDocSchema>;

/** The `scans/{scanId}` document. Timestamps are ISO strings for portability. */
export const ScanDocSchema = z.object({
  id: z.string(),
  target: TargetSchema,
  // 'url' = black-box free/URL scan (default); 'deep' = white-box connected scan;
  // 'upload' = white-box scan of a folder/zip the user uploaded (Pro-only, one-shot).
  type: z.enum(['url', 'deep', 'upload']).default('url'),
  // For deep scans: which connected sources feed it (+ optional URL). `githubRepo`
  // is the specific owner/name the user chose to scan (validated against their
  // installation); absent → the connection's default repo (back-compat).
  // `upload` marks an uploaded-folder scan (source staged, extracted, then wiped).
  sources: z.object({ github: z.boolean().optional(), githubRepo: z.string().optional(), supabase: z.boolean().optional(), url: z.string().optional(), upload: z.boolean().optional() }).optional(),
  // null = anonymous free scan (unchanged); a uid = owned by that user.
  ownerUid: z.string().nullable().default(null),
  // Slice 7 (monitoring): 'monitor' = an automatic re-scan (scheduled or push),
  // which the worker diffs against the app's previous scan + may alert on. `appId`
  // ties the scan back to the user's app-registry entry it was triggered for.
  origin: z.enum(['user', 'monitor']).optional(),
  appId: z.string().optional(),
  status: z.enum(['queued', 'running', 'done', 'error']),
  grade: GradeSchema.optional(),
  score: z.number().int().optional(),
  counts: CountsSchema.optional(),
  error: z.string().optional(),
  // Detected tech stack of a deep-scanned repo (client-readable, non-secret) —
  // drives "connect Supabase for a deeper scan" / Firebase-rules-not-in-repo hints.
  stack: z
    .object({ supabase: z.boolean().optional(), firebase: z.boolean().optional(), firebaseRulesInRepo: z.boolean().optional() })
    .optional(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  progress: z
    .object({ done: z.number().int(), total: z.number().int(), phase: z.string() })
    .optional(),
});
export type ScanDoc = z.infer<typeof ScanDocSchema>;

/** The job payload carried by the queue. */
export interface ScanJob {
  scanId: string;
}

/* -------------------------------------------------------------------------- */
/* Slice 7 — Monitoring                                                        */
/* -------------------------------------------------------------------------- */

/** How often an app is automatically re-scanned. 'push' = on every git push. */
export type Cadence = 'off' | 'push' | 'daily' | 'weekly' | 'biweekly' | 'monthly';

/** Which new-finding severities are worth an alert. */
export type AlertSeverity = 'critical' | 'high';

/**
 * Per-app monitoring config. Lives (client-owned) on `users/{uid}.apps[i].monitoring`
 * — the client sets it; the scheduler/webhook read it. Run state (last scan, grade,
 * push-debounce) is server-owned and lives in `monitorRuns/{uid}__{appId}`.
 */
export interface AppMonitoring {
  cadence: Cadence;
  /** Email the user when a new alert-worthy finding appears. */
  emailAlerts: boolean;
  /** Lowest severity that triggers an alert (default 'critical'). */
  severity?: AlertSeverity;
}

/** A registry app as stored on the user doc (mirrors the frontend `AppRecord`). */
export interface RegistryApp {
  id: string;
  name: string;
  url?: string;
  githubRepo?: string;
  createdAt: string;
  monitoring?: AppMonitoring;
}

/** A single finding's identity as recorded on a monitoring event (client-readable). */
export interface MonitorFindingRef {
  key: string; // stable finding id
  ruleId: string;
  severity: string;
  title: string;
  where?: string;
}

/** The diff of one monitoring scan vs the app's previous scan. Owner-readable. */
export interface MonitorEvent {
  id: string;
  uid: string;
  appId: string;
  scanId: string;
  prevScanId: string | null;
  newFindings: MonitorFindingRef[];
  resolvedFindings: MonitorFindingRef[];
  gradeBefore: string | null;
  gradeAfter: string | null;
  /** True when this event sent an alert (new critical/high or a grade drop). */
  alerted: boolean;
  createdAt: string;
}

export type Provider = 'github' | 'supabase';

/** Non-secret connection metadata stored (client-readable) under users/{uid}.connections. */
export interface GitHubConnectionMeta {
  repo: string;
  scopes: string[];
  writeAccess: false;
  mock: boolean;
  connectedAt: string;
}
export interface SupabaseConnectionMeta {
  projectRef: string;
  projectName?: string;
  org?: string;
  access: 'read-only';
  scopes?: string[];
  // 'oauth' = connected via Supabase Management API OAuth; 'mock-path' = local fixture.
  mode?: 'oauth' | 'mock-path';
  mock: boolean;
  // Set when a token refresh failed at scan time; the user must reconnect.
  needsReconnect?: boolean;
  connectedAt: string;
}

/** Decrypted credential payloads (only ever in memory server-side). */
export type GitHubSecret = { mock: true; repoPath: string } | { mock: false; installationId: number; repo: string };
export type SupabaseSecret =
  // Legacy MOCK path (POST /connectSupabase { policiesPath }) — points at a fixture.
  | { mode: 'mock-path'; policiesPath: string }
  // OAuth (real or mock): encrypted access/refresh tokens + which project. In MOCK
  // mode a policiesPath fixture is carried so the scan reads local .sql.
  | { mode: 'oauth'; mock: boolean; accessToken: string; refreshToken?: string; expiresAt?: number; projectRef: string; policiesPath?: string };
