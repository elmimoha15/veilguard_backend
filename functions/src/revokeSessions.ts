import { getAuth } from 'firebase-admin/auth';
import { requireAuth, AuthError } from './auth.js';
import type { HttpResult } from './createScan.js';

/**
 * POST /auth/revokeSessions — "sign out of all devices". Revokes the caller's
 * refresh tokens so every already-issued session is invalidated: because the API
 * verifies tokens with checkRevoked=true, other devices are rejected on their
 * next request (and can't mint new tokens). The caller signs out locally too.
 */
export async function handleRevokeSessions(authHeader: string | undefined): Promise<HttpResult> {
  let uid: string;
  try {
    ({ uid } = await requireAuth(authHeader));
  } catch (e) {
    if (e instanceof AuthError) return { status: e.status, body: { error: e.message, code: e.code } };
    throw e;
  }
  try {
    await getAuth().revokeRefreshTokens(uid);
    return { status: 200, body: { ok: true } };
  } catch (e) {
    console.error('[revokeSessions] failed:', e);
    return { status: 500, body: { error: 'could not sign out other devices — try again' } };
  }
}
