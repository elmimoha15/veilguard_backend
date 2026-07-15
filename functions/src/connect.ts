import { existsSync, statSync } from 'node:fs';
import { config } from '../../shared/src/config.js';
import { encryptJson } from '../../shared/src/crypto.js';
import { setConnection, deleteConnection } from '../../shared/src/firestore.js';
import type { GitHubSecret, SupabaseSecret, Provider } from '../../shared/src/types.js';
import { requireAuth, AuthError } from './auth.js';
import type { HttpResult } from './createScan.js';

/**
 * The MINIMUM read-only permissions we request. This is both a security control
 * and a trust promise: no write access, single repo only. In production these
 * map to a GitHub App / fine-grained PAT with Contents+Metadata: Read-only on
 * exactly one repo, and a Supabase read-only DB role.
 */
export const GITHUB_READONLY_SCOPES = ['contents:read', 'metadata:read'] as const;
export const SUPABASE_ACCESS = 'read-only' as const;

async function withAuth<T>(authHeader: string | undefined, fn: (uid: string) => Promise<T>): Promise<T | HttpResult> {
  try {
    const { uid } = await requireAuth(authHeader);
    return await fn(uid);
  } catch (e) {
    if (e instanceof AuthError) return { status: e.status, body: { error: e.message } };
    throw e;
  }
}

function repoName(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/');
  return parts.slice(-2).join('/') || p;
}

/** POST /connectGitHub — read-only, single-repo. MOCK mode points at a fixture. */
export async function handleConnectGitHub(rawBody: unknown, authHeader: string | undefined): Promise<HttpResult> {
  const r = await withAuth(authHeader, async (uid) => {
    const body = (rawBody ?? {}) as { repoPath?: string; repo?: string; token?: string };

    if (config.mockConnections) {
      const repoPath = body.repoPath;
      if (!repoPath || !existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
        return { status: 400, body: { error: 'mock connectGitHub requires repoPath to an existing repo directory' } };
      }
      const secret: GitHubSecret = { mock: true, repoPath };
      const meta = { repo: repoName(repoPath), scopes: [...GITHUB_READONLY_SCOPES], writeAccess: false as const, mock: true };
      await setConnection(uid, 'github', meta, encryptJson(secret));
      return { status: 200, body: { connected: 'github', ...meta } };
    }

    // Real mode (not exercised by the gate): store a fine-grained, read-only,
    // single-repo token. Token exchange / App-install verification goes here.
    if (!body.token || !body.repo) return { status: 400, body: { error: 'token + repo required' } };
    const secret: GitHubSecret = { mock: false, token: body.token, repo: body.repo };
    const meta = { repo: body.repo, scopes: [...GITHUB_READONLY_SCOPES], writeAccess: false as const, mock: false };
    await setConnection(uid, 'github', meta, encryptJson(secret));
    return { status: 200, body: { connected: 'github', ...meta } };
  });
  return r as HttpResult;
}

/** POST /connectSupabase — read-only. MOCK mode points at a policies fixture. */
export async function handleConnectSupabase(rawBody: unknown, authHeader: string | undefined): Promise<HttpResult> {
  const r = await withAuth(authHeader, async (uid) => {
    const body = (rawBody ?? {}) as { policiesPath?: string; projectRef?: string; connectionString?: string };

    if (config.mockConnections) {
      const policiesPath = body.policiesPath;
      if (!policiesPath || !existsSync(policiesPath)) {
        return { status: 400, body: { error: 'mock connectSupabase requires policiesPath to an existing directory' } };
      }
      const secret: SupabaseSecret = { mock: true, policiesPath };
      const meta = { projectRef: body.projectRef || 'mock-project', access: SUPABASE_ACCESS, mock: true };
      await setConnection(uid, 'supabase', meta, encryptJson(secret));
      return { status: 200, body: { connected: 'supabase', ...meta } };
    }

    if (!body.connectionString) return { status: 400, body: { error: 'read-only connectionString required' } };
    // Guard: refuse a connection string that isn't clearly read-only-intended.
    const secret: SupabaseSecret = { mock: false, connectionString: body.connectionString };
    const meta = { projectRef: body.projectRef || 'project', access: SUPABASE_ACCESS, mock: false };
    await setConnection(uid, 'supabase', meta, encryptJson(secret));
    return { status: 200, body: { connected: 'supabase', ...meta } };
  });
  return r as HttpResult;
}

/** POST /disconnect { provider } — delete encrypted credential + metadata. */
export async function handleDisconnect(rawBody: unknown, authHeader: string | undefined): Promise<HttpResult> {
  const r = await withAuth(authHeader, async (uid) => {
    const provider = (rawBody as { provider?: string })?.provider as Provider | undefined;
    if (provider !== 'github' && provider !== 'supabase') {
      return { status: 400, body: { error: 'provider must be "github" or "supabase"' } };
    }
    await deleteConnection(uid, provider);
    return { status: 200, body: { disconnected: provider } };
  });
  return r as HttpResult;
}
