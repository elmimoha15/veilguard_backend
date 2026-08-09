import { CreateScanInputSchema } from '../../shared/src/types.js';
import { createScanDoc, getPlan } from '../../shared/src/firestore.js';
import { canScan, scanLimit } from '../../shared/src/usage.js';
import type { Queue } from '../../shared/src/queue.js';
import { config } from '../../shared/src/config.js';
import { rateLimit } from './rate-limit.js';
import { guardPublicTarget } from './target-guard.js';

export interface HttpResult {
  status: number;
  body: unknown;
}

export interface CreateScanOptions {
  clientIp?: string;
  /** Permit localhost/private-IP targets (local dev / tests). Default from config. */
  allowPrivateTargets?: boolean;
  /** Owner uid when the caller is authenticated; null/undefined = anonymous. */
  ownerUid?: string | null;
}

/**
 * The public createScan handler, framework-agnostic so it can be hosted by a
 * Cloud Function OR a plain express route OR called directly in tests.
 *
 * Thin by design: validate → SSRF/abuse guard → rate-limit → create a "queued"
 * doc → enqueue → return { scanId }. It NEVER runs the scan (that's the worker).
 */
export async function handleCreateScan(
  rawBody: unknown,
  queue: Queue,
  opts: CreateScanOptions = {},
): Promise<HttpResult> {
  const clientIp = opts.clientIp ?? 'local';
  const allowPrivate = opts.allowPrivateTargets ?? config.allowPrivateTargets;

  const parsed = CreateScanInputSchema.safeParse(rawBody);
  if (!parsed.success) {
    return { status: 400, body: { error: 'invalid input', details: parsed.error.flatten() } };
  }
  const { target } = parsed.data;

  // Public-path abuse guard: url-only, http/https, no localhost/private IPs.
  const guard = guardPublicTarget(target, allowPrivate);
  if (!guard.ok) {
    return { status: 400, body: { error: guard.error } };
  }

  // Two buckets: a tight per-(IP,target) cap (repeat-scan spam) AND a broader
  // per-IP cap across ALL targets — otherwise one IP can spray unlimited distinct
  // URLs (5 each). Both are in-memory/per-process (a distributed limiter is future).
  const rl = rateLimit(`${clientIp}|${target.value}`);
  if (!rl.allowed) {
    return { status: 429, body: { error: 'rate limited', retryAfterMs: rl.retryAfterMs } };
  }
  const ipRl = rateLimit(`ip|${clientIp}`, config.freeScanIpMax, config.freeScanIpWindowMs);
  if (!ipRl.allowed) {
    return { status: 429, body: { error: 'rate limited', retryAfterMs: ipRl.retryAfterMs } };
  }

  // Monthly scan cap (owned scans only — anonymous public scans are exempt, they
  // are IP-rate-limited instead). Every scan type draws from the per-plan pool.
  if (opts.ownerUid) {
    const plan = await getPlan(opts.ownerUid);
    if (!(await canScan(opts.ownerUid, plan))) {
      const n = scanLimit(plan);
      return {
        status: 429,
        body: { error: `Monthly scan limit reached (${n}/${n}). It resets next cycle — upgrade or reach out for a higher limit.`, code: 'E_SCAN_LIMIT' },
      };
    }
  }

  const scanId = await createScanDoc(target, opts.ownerUid ?? null);
  await queue.enqueue({ scanId });

  return { status: 202, body: { scanId } };
}
