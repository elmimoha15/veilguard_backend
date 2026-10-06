import { getAuth } from 'firebase-admin/auth';
import { getDb } from '../../shared/src/firestore.js';

/** Thrown when auth fails; carries the HTTP status to return and an optional
 *  machine-readable code (e.g. 'reauth_required') for the client to branch on. */
export class AuthError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

export interface AuthInfo {
  uid: string;
  email?: string;
  name?: string;
  provider?: string;
  /** Unix seconds of the token's last interactive sign-in (`auth_time` claim),
   *  used to enforce step-up reauth on sensitive actions. */
  authTime?: number;
}

/** Max age (seconds) of a sign-in for a sensitive action before we demand a fresh
 *  login. Mirrors REAUTH_MAX_AGE_MS on the client. */
export const REAUTH_MAX_AGE_SEC = 600; // 10 minutes

function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1]!.trim() : null;
}

/**
 * Resolve the caller's identity from the Authorization header.
 *  - no token           → { uid: null }        (anonymous is allowed)
 *  - present but bad     → throws AuthError(401) (never silently downgrade)
 *  - valid              → { info }              (verified via Admin SDK)
 */
export async function resolveAuth(authHeader: string | undefined): Promise<AuthInfo | null> {
  const token = bearer(authHeader);
  if (!token) return null;
  try {
    getDb(); // ensure the Admin app is initialized (with the right projectId)
    // checkRevoked=true: reject tokens whose session was revoked (sign-out-all-
    // devices) or whose user was deleted, instead of trusting them until ~1h
    // expiry. Costs one Admin-SDK user lookup per request (SDK-cached).
    const decoded = await getAuth().verifyIdToken(token, true);
    return {
      uid: decoded.uid,
      email: decoded.email,
      name: (decoded.name as string | undefined) ?? undefined,
      provider: (decoded.firebase?.sign_in_provider as string | undefined) ?? undefined,
      authTime: typeof decoded.auth_time === 'number' ? decoded.auth_time : undefined,
    };
  } catch {
    throw new AuthError(401, 'invalid or expired token');
  }
}

/** Require a valid token; throws AuthError(401) if missing or invalid. */
export async function requireAuth(authHeader: string | undefined): Promise<AuthInfo> {
  const info = await resolveAuth(authHeader);
  if (!info) throw new AuthError(401, 'authentication required');
  return info;
}

/**
 * Require a valid token AND a RECENT interactive sign-in (step-up reauth) for a
 * sensitive action. Throws AuthError(401, code='reauth_required') when the last
 * sign-in is older than `maxAgeSec`, so a modified client can't skip the prompt.
 */
export async function requireFreshAuth(
  authHeader: string | undefined,
  maxAgeSec: number = REAUTH_MAX_AGE_SEC,
): Promise<AuthInfo> {
  const info = await requireAuth(authHeader);
  const ageSec = info.authTime ? Date.now() / 1000 - info.authTime : Infinity;
  if (ageSec > maxAgeSec) {
    throw new AuthError(401, 'reauthentication required', 'reauth_required');
  }
  return info;
}

/** Alias for readability at call sites where anonymous is fine. */
export const optionalAuth = resolveAuth;
