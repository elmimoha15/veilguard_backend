import { CreateScanInputSchema } from '../../shared/src/types.js';
import { createScanDoc } from '../../shared/src/firestore.js';
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

  const key = `${clientIp}|${target.value}`;
  const rl = rateLimit(key);
  if (!rl.allowed) {
    return { status: 429, body: { error: 'rate limited', retryAfterMs: rl.retryAfterMs } };
  }

  const scanId = await createScanDoc(target);
  await queue.enqueue({ scanId });

  return { status: 202, body: { scanId } };
}
