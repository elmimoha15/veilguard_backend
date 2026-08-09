import { config } from '../../shared/src/config.js';

/**
 * Minimal in-memory sliding-window rate limiter (per-key). Good enough for this
 * slice to prevent abuse loops; a distributed limiter comes with real traffic.
 */
const hits = new Map<string, number[]>();

/**
 * Sliding-window limiter. `max`/`windowMs` default to the base createScan limit
 * (5/min); pass overrides for a different bucket (e.g. the broader per-IP cap).
 */
export function rateLimit(
  key: string,
  max: number = config.rateLimitMax,
  windowMs: number = config.rateLimitWindowMs,
): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  const windowStart = now - windowMs;
  const arr = (hits.get(key) ?? []).filter((t) => t > windowStart);

  if (arr.length >= max) {
    const oldest = arr[0]!;
    return { allowed: false, retryAfterMs: oldest + windowMs - now };
  }
  arr.push(now);
  hits.set(key, arr);
  return { allowed: true, retryAfterMs: 0 };
}

/** Test hook. */
export function resetRateLimit(): void {
  hits.clear();
}
