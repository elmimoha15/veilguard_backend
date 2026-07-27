import { decryptJson } from '../../shared/src/crypto.js';
import { getEncryptedSecret } from '../../shared/src/firestore.js';
import { listInstallationRepos, type RepoSummary } from '../../shared/src/github-app.js';
import type { GitHubSecret } from '../../shared/src/types.js';
import { requireAuth, AuthError } from './auth.js';
import type { HttpResult } from './createScan.js';

/** owner/name from a filesystem path (mock repos). */
function repoName(p: string): string {
  return p.replace(/\/+$/, '').split('/').slice(-2).join('/') || p;
}

/**
 * POST /github/repos (auth required) — list the repositories the caller's
 * connected GitHub installation can access, for the repo picker. Read-only.
 * Returns 409 if GitHub isn't connected. In MOCK mode returns the single fixture
 * repo so the flow works credential-free in tests/emulator.
 */
export async function handleListGitHubRepos(authHeader: string | undefined): Promise<HttpResult> {
  let uid: string;
  try {
    uid = (await requireAuth(authHeader)).uid;
  } catch (e) {
    if (e instanceof AuthError) return { status: e.status, body: { error: e.message } };
    throw e;
  }

  const blob = await getEncryptedSecret(uid, 'github');
  if (!blob) return { status: 409, body: { error: 'GitHub is not connected — connect it in Settings first' } };

  const secret = decryptJson<GitHubSecret>(blob);
  if (secret.mock) {
    const repos: RepoSummary[] = [{ fullName: repoName(secret.repoPath), private: true }];
    return { status: 200, body: { repos } };
  }

  try {
    const repos = await listInstallationRepos(secret.installationId);
    return { status: 200, body: { repos } };
  } catch (e) {
    console.error('[github] list repos failed:', e instanceof Error ? e.message : e);
    return { status: 502, body: { error: 'could not list GitHub repositories — try reconnecting GitHub' } };
  }
}
