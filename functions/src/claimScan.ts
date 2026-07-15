import { claimScan } from '../../shared/src/firestore.js';
import { requireAuth, AuthError } from './auth.js';
import type { HttpResult } from './createScan.js';

/**
 * POST /claimScan { scanId } — assign the caller as owner of a currently
 * ownerless (anonymous) scan, so a pre-signup free scan shows up in their
 * account. Auth required. Only ownerless scans can be claimed.
 */
export async function handleClaimScan(rawBody: unknown, authHeader: string | undefined): Promise<HttpResult> {
  let uid: string;
  try {
    uid = (await requireAuth(authHeader)).uid;
  } catch (e) {
    if (e instanceof AuthError) return { status: e.status, body: { error: e.message } };
    throw e;
  }

  const scanId = (rawBody as { scanId?: unknown })?.scanId;
  if (typeof scanId !== 'string' || !scanId) {
    return { status: 400, body: { error: 'scanId required' } };
  }

  const result = await claimScan(scanId, uid);
  if (!result.ok) return { status: result.status, body: { error: result.error } };
  return { status: 200, body: { ok: true, scanId, ownerUid: uid } };
}
