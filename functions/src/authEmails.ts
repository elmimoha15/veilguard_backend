import { getAuth } from 'firebase-admin/auth';
import { getDb } from '../../shared/src/firestore.js';
import { config } from '../../shared/src/config.js';
import { sendVerify, sendPasswordReset } from '../../shared/src/emails/senders.js';
import { requireAuth, AuthError } from './auth.js';
import { rateLimit } from './rate-limit.js';
import type { HttpResult } from './createScan.js';

/** Where Firebase sends the user after they click a verify/reset link. */
const actionSettings = () => ({ url: `${config.appBaseUrl}/login` });

/**
 * POST /auth/sendVerification — auth required. Generates a Firebase verification
 * link for the caller's own email (Admin SDK) and sends the branded email via
 * Resend. Replaces Firebase's built-in verification mailer.
 */
export async function handleSendVerification(authHeader: string | undefined): Promise<HttpResult> {
  let email: string | undefined;
  try {
    email = (await requireAuth(authHeader)).email;
  } catch (e) {
    if (e instanceof AuthError) return { status: e.status, body: { error: e.message } };
    throw e;
  }
  if (!email) return { status: 400, body: { error: 'no email on this account' } };
  try {
    getDb(); // ensure the Admin app is initialized
    const link = await getAuth().generateEmailVerificationLink(email, actionSettings());
    await sendVerify(email, link);
  } catch (e) {
    console.error('[email] verification send failed:', (e as Error)?.message);
    return { status: 502, body: { error: 'could not send the verification email — try again' } };
  }
  return { status: 200, body: { ok: true } };
}

/**
 * POST /auth/sendReset { email } — PUBLIC, rate-limited. Generates a reset link
 * and sends the branded email. ALWAYS returns 200 (even for an unknown or
 * OAuth-only email) so it can't be used to probe which emails have accounts.
 */
export async function handleSendReset(rawBody: unknown, clientIp: string): Promise<HttpResult> {
  const email = (rawBody as { email?: string })?.email?.trim();
  if (!email) return { status: 400, body: { error: 'email is required' } };

  const rl = rateLimit(`reset|${clientIp}|${email.toLowerCase()}`);
  if (!rl.allowed) return { status: 429, body: { error: 'too many requests — try again shortly' } };

  try {
    getDb();
    const link = await getAuth().generatePasswordResetLink(email, actionSettings());
    await sendPasswordReset(email, link);
  } catch (e) {
    // Unknown email / OAuth-only user / transient send failure → swallow so the
    // response is identical whether or not the account exists (no enumeration).
    console.error('[email] reset (suppressed):', (e as Error)?.message);
  }
  return { status: 200, body: { ok: true } };
}
