import { getAuth } from 'firebase-admin/auth';
import { getDb } from '../../shared/src/firestore.js';

/** Thrown when auth fails; carries the HTTP status to return. */
export class AuthError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface AuthInfo {
  uid: string;
  email?: string;
  name?: string;
  provider?: string;
}

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
    const decoded = await getAuth().verifyIdToken(token);
    return {
      uid: decoded.uid,
      email: decoded.email,
      name: (decoded.name as string | undefined) ?? undefined,
      provider: (decoded.firebase?.sign_in_provider as string | undefined) ?? undefined,
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

/** Alias for readability at call sites where anonymous is fine. */
export const optionalAuth = resolveAuth;
