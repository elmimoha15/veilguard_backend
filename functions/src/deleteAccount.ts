import { getAuth } from 'firebase-admin/auth';
import { config } from '../../shared/src/config.js';
import { decryptJson } from '../../shared/src/crypto.js';
import { getEncryptedSecret, purgeUserFirestore } from '../../shared/src/firestore.js';
import { revokeToken } from '../../shared/src/supabase-api.js';
import { deletePolarCustomerByExternalId } from '../../shared/src/polar.js';
import { sendAccountDeleted } from '../../shared/src/emails/senders.js';
import type { SupabaseSecret } from '../../shared/src/types.js';
import { requireAuth, AuthError } from './auth.js';
import type { HttpResult } from './createScan.js';

/**
 * Permanently delete the caller's account: revoke upstream tokens, cancel any
 * paid subscription (hook), wipe every Firestore store keyed to the uid, then
 * delete the Firebase Auth login. Irreversible. Best-effort on external steps
 * (log & continue) so a flaky third-party call can't strand the core deletion.
 */
export async function handleDeleteAccount(authHeader: string | undefined): Promise<HttpResult> {
  let uid: string;
  let email: string | undefined;
  try {
    ({ uid, email } = await requireAuth(authHeader));
  } catch (e) {
    if (e instanceof AuthError) return { status: e.status, body: { error: e.message } };
    throw e;
  }

  // 1) Best-effort revoke the Supabase OAuth token upstream (mirrors handleDisconnect).
  try {
    const blob = await getEncryptedSecret(uid, 'supabase');
    if (blob) {
      const s = decryptJson<SupabaseSecret>(blob);
      if (s.mode === 'oauth' && !s.mock) await revokeToken(s.accessToken);
    }
  } catch (e) {
    console.error('[deleteAccount] supabase revoke failed (continuing):', e);
  }

  // 2) Delete the Polar customer — cancels any active subscription AND removes
  //    them from Polar's customer list, so re-signing-up with this email doesn't
  //    hit "you already have an active subscription". We delete BY EXTERNAL ID
  //    (= uid, set as externalCustomerId at checkout) so this works even when we
  //    never captured a `polarCustomerId`. A free user with no customer is a
  //    clean no-op. Best-effort: never block the local deletion on a Polar error.
  if (config.polarConfigured) {
    try {
      const deleted = await deletePolarCustomerByExternalId(uid);
      console.log(`[deleteAccount] ${uid}: Polar customer ${deleted ? 'deleted' : 'none (no-op)'}`);
    } catch (e) {
      console.error('[deleteAccount] Polar customer delete failed (continuing):', e);
    }
  }

  // 3) Wipe every Firestore store keyed to the uid (scans+findings, monitoring,
  //    secrets, user doc incl. plan/apps/connections, oauth state).
  const summary = await purgeUserFirestore(uid);

  // Confirmation email — fire-and-forget so a mail failure never blocks deletion.
  // Sent with the address captured from the token (the user doc is already gone).
  if (email) void sendAccountDeleted(email).catch((e) => console.error('[deleteAccount] confirmation email failed:', e));

  // 4) Delete the Firebase Auth login last, so a failure above doesn't leave an
  //    authenticated session with no data. Idempotent-ish: ignore "not found".
  try {
    await getAuth().deleteUser(uid);
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code !== 'auth/user-not-found') {
      console.error('[deleteAccount] auth deleteUser failed:', e);
      return { status: 500, body: { error: 'Account data was removed but the login could not be deleted. Please contact support.' } };
    }
  }

  console.log(`[deleteAccount] purged ${uid}:`, summary);
  return { status: 200, body: { ok: true } };
}
