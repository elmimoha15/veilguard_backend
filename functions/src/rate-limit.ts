import { config } from '../../shared/src/config.js';

/**
 * Minimal in-memory sliding-window rate limiter (per-key). Good enough for this
 * slice to prevent abuse loops; a distributed limiter comes with real traffic.
 */
const hits = new Map<string, number[]>();

export function rateLimit(key: string): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  const windowStart = now - config.rateLimitWindowMs;
  const arr = (hits.get(key) ?? []).filter((t) => t > windowStart);

  if (arr.length >= config.rateLimitMax) {
    const oldest = arr[0]!;
    return { allowed: false, retryAfterMs: oldest + config.rateLimitWindowMs - now };
  }
  arr.push(now);
  hits.set(key, arr);
  return { allowed: true, retryAfterMs: 0 };
}

/** Test hook. */
export function resetRateLimit(): void {
  hits.clear();
}
