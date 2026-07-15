import { CreateScanInputSchema } from '../../shared/src/types.js';
import { createScanDoc } from '../../shared/src/firestore.js';
import type { Queue } from '../../shared/src/queue.js';
import { rateLimit } from './rate-limit.js';

export interface HttpResult {
  status: number;
  body: unknown;
}

/**
 * The createScan handler, framework-agnostic so it can be hosted by a Cloud
 * Function OR a plain express route OR called directly in tests.
 *
 * It is deliberately thin: validate → rate-limit → create a "queued" doc →
 * enqueue → return { scanId }. It NEVER runs the scan (that's the worker).
 */
export async function handleCreateScan(
  rawBody: unknown,
  queue: Queue,
  clientIp = 'local',
): Promise<HttpResult> {
  const parsed = CreateScanInputSchema.safeParse(rawBody);
  if (!parsed.success) {
    return { status: 400, body: { error: 'invalid input', details: parsed.error.flatten() } };
  }
  const { target } = parsed.data;

  const key = `${clientIp}|${target.value}`;
  const rl = rateLimit(key);
  if (!rl.allowed) {
    return { status: 429, body: { error: 'rate limited', retryAfterMs: rl.retryAfterMs } };
  }

  const scanId = await createScanDoc(target);
  await queue.enqueue({ scanId });

  return { status: 202, body: { scanId } };
}
