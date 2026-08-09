import { purgeAppFirestore, type AppTarget } from '../../shared/src/firestore.js';
import { requireAuth, AuthError } from './auth.js';
import type { HttpResult } from './createScan.js';

/**
 * POST /app/delete { appId?, githubRepo?, url? } — permanently delete ONE of the
 * caller's apps and everything tied to it: all its scans (+ findings + private
 * fixes), its monitoring run-state + events, and its entry in the app registry
 * (which drops its monitoring config). Irreversible.
 *
 * Ownership is enforced: every store is keyed to the authenticated uid, so a
 * caller can only ever delete its own app. The shared provider connections
 * (GitHub/Supabase) and the user's plan are deliberately left intact — they are
 * account-level and used by the user's other apps.
 */
export async function handleDeleteApp(rawBody: unknown, authHeader: string | undefined): Promise<HttpResult> {
  let uid: string;
  try {
    ({ uid } = await requireAuth(authHeader));
  } catch (e) {
    if (e instanceof AuthError) return { status: e.status, body: { error: e.message } };
    throw e;
  }

  const body = (rawBody ?? {}) as { appId?: unknown; githubRepo?: unknown; url?: unknown };
  const target: AppTarget = {
    appId: typeof body.appId === 'string' && body.appId ? body.appId : undefined,
    githubRepo: typeof body.githubRepo === 'string' && body.githubRepo ? body.githubRepo : undefined,
    url: typeof body.url === 'string' && body.url ? body.url : undefined,
  };
  if (!target.appId && !target.githubRepo && !target.url) {
    return { status: 400, body: { error: 'identify the app to delete: appId, githubRepo, or url' } };
  }

  try {
    const result = await purgeAppFirestore(uid, target);
    return { status: 200, body: { ok: true, ...result } };
  } catch (e) {
    console.error('[deleteApp] purge failed:', e instanceof Error ? e.message : e);
    return { status: 500, body: { error: 'could not delete the app — try again' } };
  }
}
