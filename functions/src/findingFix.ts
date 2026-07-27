import { getScan, readPrivateFix } from '../../shared/src/firestore.js';
import { requireAuth, AuthError } from './auth.js';
import { requirePaid } from './plan-gate.js';
import type { HttpResult } from './createScan.js';

/**
 * POST /findingFix { scanId, findingId } — return the PAID fix content for a
 * finding. The fix/fixPrompt live in `scans/{id}/findings/{fid}/private/fix`,
 * which firestore.rules deny to every client — so this server endpoint is the
 * only way to read them, and only for a paid owner. Free users get 402 and keep
 * seeing the locked panel. (Generalizes the emulator-only dev.ts unlock.)
 */
export async function handleFindingFix(
  scanId: string | undefined,
  findingId: string | undefined,
  authHeader: string | undefined,
): Promise<HttpResult> {
  if (!scanId || !findingId) {
    return { status: 400, body: { error: 'scanId and findingId are required' } };
  }

  let uid: string;
  try {
    uid = (await requireAuth(authHeader)).uid;
  } catch (e) {
    if (e instanceof AuthError) return { status: e.status, body: { error: e.message } };
    throw e;
  }

  const scan = await getScan(scanId);
  if (!scan) return { status: 404, body: { error: 'scan not found' } };
  // Only the owner (or an ownerless anon scan) may read the fix.
  if (scan.ownerUid !== null && scan.ownerUid !== uid) {
    return { status: 403, body: { error: 'not your scan' } };
  }
  // Fixes are a paid feature.
  if (!(await requirePaid(uid))) {
    return { status: 402, body: { error: 'Fixes are a Pro feature — upgrade to unlock.' } };
  }

  const fix = await readPrivateFix(scanId, findingId);
  if (!fix) return { status: 404, body: { error: 'no fix for this finding' } };
  return { status: 200, body: { fix: fix.fix, fixPrompt: fix.fixPrompt } };
}
