import { config } from '../../shared/src/config.js';
import { getScan, readPrivateFix } from '../../shared/src/firestore.js';
import { requireAuth, AuthError } from './auth.js';
import type { HttpResult } from './createScan.js';

/**
 * DEV-ONLY fake-paid preview. Returns the locked fix/fixPrompt for a finding so
 * the frontend can preview the unlocked UI before real billing exists.
 *
 * Hard gates (any failure → refuse):
 *  - config.devFakePaid  (DEV_FAKE_PAID=1 AND running on the emulator)
 *  - a valid ID token, and the caller OWNS the scan (or it's an anon scan)
 *
 * The real firestore.rules are UNCHANGED — private/fix stays denied to every
 * client. This endpoint reads it via the Admin SDK, and only when the dev flag
 * is set. It must never be reachable in production.
 */
export async function handleUnlockedFinding(
  scanId: string | undefined,
  findingId: string | undefined,
  authHeader: string | undefined,
): Promise<HttpResult> {
  if (!config.devFakePaid) {
    return { status: 403, body: { error: 'fake-paid preview is disabled (production-safe default)' } };
  }
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
  // Ownership: only the owner (or an ownerless anon scan) may preview.
  if (scan.ownerUid !== null && scan.ownerUid !== uid) {
    return { status: 403, body: { error: 'not your scan' } };
  }

  const fix = await readPrivateFix(scanId, findingId);
  if (!fix) return { status: 404, body: { error: 'no fix for this finding' } };
  return { status: 200, body: { fix: fix.fix, fixPrompt: fix.fixPrompt, dev: true } };
}
