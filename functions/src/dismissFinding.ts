import { setDismissed } from '../../shared/src/dismissals.js';
import { requireAuth, AuthError } from './auth.js';
import type { HttpResult } from './createScan.js';

/**
 * POST /findings/dismiss { scanId, findingId, reason? } — "Not an issue? Mark as
 * false positive". Owner only. Hides the finding for this app on this and future
 * scans (kept in a collapsed "Dismissed" list), re-grades the scan server-side,
 * and files a report for review.
 *
 * POST /findings/undismiss { scanId, findingId } — undo.
 */
export async function handleDismissFinding(rawBody: unknown, authHeader: string | undefined, dismissed: boolean): Promise<HttpResult> {
  let uid: string;
  try {
    uid = (await requireAuth(authHeader)).uid;
  } catch (e) {
    if (e instanceof AuthError) return { status: e.status, body: { error: e.message } };
    throw e;
  }
  const body = (rawBody ?? {}) as { scanId?: unknown; findingId?: unknown; reason?: unknown };
  if (typeof body.scanId !== 'string' || !body.scanId || typeof body.findingId !== 'string' || !body.findingId) {
    return { status: 400, body: { error: 'scanId and findingId required' } };
  }
  if (body.reason !== undefined && typeof body.reason !== 'string') {
    return { status: 400, body: { error: 'reason must be text' } };
  }
  const r = await setDismissed(uid, body.scanId, body.findingId, dismissed, body.reason as string | undefined);
  if (!r.ok) return { status: r.status, body: { error: r.error } };
  return { status: 200, body: r };
}
