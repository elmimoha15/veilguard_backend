import { existsSync, statSync } from 'node:fs';
import { config } from '../../shared/src/config.js';
import { encryptJson, decryptJson } from '../../shared/src/crypto.js';
import { setConnection, deleteConnection, getEncryptedSecret } from '../../shared/src/firestore.js';
import { revokeToken } from '../../shared/src/supabase-api.js';
import type { GitHubSecret, SupabaseSecret, Provider } from '../../shared/src/types.js';
import { requireAuth, AuthError } from './auth.js';
import { requirePaid } from './plan-gate.js';
import type { HttpResult } from './createScan.js';

/** Connections feed deep/white-box scans, so connecting is a paid feature. */
const PAID_CONNECT_ERROR = { status: 402 as const, body: { error: 'Connecting a repo/database is a Pro feature — upgrade to connect.' } };

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
    if (!(await requirePaid(uid))) return PAID_CONNECT_ERROR;
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

    // Real GitHub connections now go through the GitHub App OAuth flow
    // (POST /connect/begin → install → GET /connect/github/callback).
    void body;
    return { status: 501, body: { error: 'use POST /connect/begin { provider: "github" } for real GitHub connections' } };
  });
  return r as HttpResult;
}

/**
 * POST /connectSupabase — read-only. MOCK mode points at a local policies fixture
 * (direct, credential-free). Real Supabase connections go through the Management
 * API OAuth flow (POST /connect/begin { provider: "supabase" } → callback).
 */
export async function handleConnectSupabase(rawBody: unknown, authHeader: string | undefined): Promise<HttpResult> {
  const r = await withAuth(authHeader, async (uid) => {
    if (!(await requirePaid(uid))) return PAID_CONNECT_ERROR;
    const body = (rawBody ?? {}) as { policiesPath?: string; projectRef?: string };

    if (config.mockConnections) {
      const policiesPath = body.policiesPath;
      if (!policiesPath || !existsSync(policiesPath)) {
        return { status: 400, body: { error: 'mock connectSupabase requires policiesPath to an existing directory' } };
      }
      const secret: SupabaseSecret = { mode: 'mock-path', policiesPath };
      const meta = { projectRef: body.projectRef || 'mock-project', access: SUPABASE_ACCESS, mode: 'mock-path' as const, mock: true };
      await setConnection(uid, 'supabase', meta, encryptJson(secret));
      return { status: 200, body: { connected: 'supabase', ...meta } };
    }

    return { status: 501, body: { error: 'use POST /connect/begin { provider: "supabase" } for real Supabase connections' } };
  });
  return r as HttpResult;
}

/** POST /disconnect { provider } — delete encrypted credential + metadata (and revoke upstream). */
export async function handleDisconnect(rawBody: unknown, authHeader: string | undefined): Promise<HttpResult> {
  const r = await withAuth(authHeader, async (uid) => {
    const provider = (rawBody as { provider?: string })?.provider as Provider | undefined;
    if (provider !== 'github' && provider !== 'supabase') {
      return { status: 400, body: { error: 'provider must be "github" or "supabase"' } };
    }
    // Best-effort upstream revoke for Supabase OAuth tokens BEFORE we delete our
    // encrypted copy. Never blocks the local delete (which is the source of truth).
    if (provider === 'supabase') {
      try {
        const blob = await getEncryptedSecret(uid, 'supabase');
        if (blob) {
          const s = decryptJson<SupabaseSecret>(blob);
          if (s.mode === 'oauth' && !s.mock) await revokeToken(s.accessToken);
        }
      } catch {
        /* ignore — we still delete the local credential below */
      }
    }
    await deleteConnection(uid, provider);
    return { status: 200, body: { disconnected: provider } };
  });
  return r as HttpResult;
}
