import { z } from 'zod';
import { FindingSchema, TargetSchema, CountsSchema, GradeSchema } from 'veilguard-scanner';
import type { Finding, ScanReport, ScanProgress, Target } from 'veilguard-scanner';

export type { Finding, ScanReport, ScanProgress, Target };
export { FindingSchema };

export type ScanStatus = 'queued' | 'running' | 'done' | 'error';

/** Input accepted by POST /createScan. */
export const CreateScanInputSchema = z.object({
  target: TargetSchema,
});
export type CreateScanInput = z.infer<typeof CreateScanInputSchema>;

/** The `scans/{scanId}` document. Timestamps are ISO strings for portability. */
export const ScanDocSchema = z.object({
  id: z.string(),
  target: TargetSchema,
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
