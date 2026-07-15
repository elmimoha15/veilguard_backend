import { createDeepScanDoc, hasConnection } from '../../shared/src/firestore.js';
import type { Queue } from '../../shared/src/queue.js';
import { requireAuth, AuthError } from './auth.js';
import { rateLimit } from './rate-limit.js';
import { guardPublicTarget } from './target-guard.js';
import type { HttpResult } from './createScan.js';

/**
 * POST /createDeepScan (auth required) — white-box scan of the caller's own
 * connected GitHub repo and/or Supabase project. Requires an active connection
 * for each requested source. Never runs the scan inline (the worker does).
 */
export async function handleCreateDeepScan(
  rawBody: unknown,
  queue: Queue,
  authHeader: string | undefined,
): Promise<HttpResult> {
  let uid: string;
  try {
    uid = (await requireAuth(authHeader)).uid;
  } catch (e) {
    if (e instanceof AuthError) return { status: e.status, body: { error: e.message } };
    throw e;
  }

  const body = (rawBody ?? {}) as { github?: boolean; supabase?: boolean; url?: string };
  const sources = { github: !!body.github, supabase: !!body.supabase, url: body.url };
  if (!sources.github && !sources.supabase && !sources.url) {
    return { status: 400, body: { error: 'select at least one source: github, supabase, or url' } };
  }

  // Each requested connected source must actually be connected by THIS user.
  if (sources.github && !(await hasConnection(uid, 'github'))) {
    return { status: 409, body: { error: 'GitHub is not connected — connect a repo first' } };
  }
  if (sources.supabase && !(await hasConnection(uid, 'supabase'))) {
    return { status: 409, body: { error: 'Supabase is not connected — connect a project first' } };
  }
  if (sources.url) {
    const g = guardPublicTarget({ type: 'url', value: sources.url }, false);
    if (!g.ok) return { status: 400, body: { error: g.error } };
  }

  // Rate limit deep scans per user (they're expensive).
  const rl = rateLimit(`deep|${uid}`);
  if (!rl.allowed) return { status: 429, body: { error: 'rate limited', retryAfterMs: rl.retryAfterMs } };

  const scanId = await createDeepScanDoc(uid, sources);
  await queue.enqueue({ scanId });
  return { status: 202, body: { scanId } };
}
