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
});
export type UserDoc = z.infer<typeof UserDocSchema>;

/** The `scans/{scanId}` document. Timestamps are ISO strings for portability. */
export const ScanDocSchema = z.object({
  id: z.string(),
  target: TargetSchema,
  // 'url' = black-box free/URL scan (default); 'deep' = white-box connected scan.
  type: z.enum(['url', 'deep']).default('url'),
  // For deep scans: which connected sources feed it (+ optional URL).
  sources: z.object({ github: z.boolean().optional(), supabase: z.boolean().optional(), url: z.string().optional() }).optional(),
  // null = anonymous free scan (unchanged); a uid = owned by that user.
  ownerUid: z.string().nullable().default(null),
  status: z.enum(['queued', 'running', 'done', 'error']),
  grade: GradeSchema.optional(),
  score: z.number().int().optional(),
  counts: CountsSchema.optional(),
  error: z.string().optional(),
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
  access: 'read-only';
  mock: boolean;
  connectedAt: string;
}

/** Decrypted credential payloads (only ever in memory server-side). */
export type GitHubSecret = { mock: true; repoPath: string } | { mock: false; token: string; repo: string };
export type SupabaseSecret = { mock: true; policiesPath: string } | { mock: false; connectionString: string };
