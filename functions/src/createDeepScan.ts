import { createDeepScanDoc, hasConnection, getEncryptedSecret, getPlan } from '../../shared/src/firestore.js';
import { decryptJson } from '../../shared/src/crypto.js';
import { installationHasRepo } from '../../shared/src/github-app.js';
import { config } from '../../shared/src/config.js';
import type { GitHubSecret } from '../../shared/src/types.js';
import type { Queue } from '../../shared/src/queue.js';
import { canScan, scanLimit } from '../../shared/src/usage.js';
import { requireAuth, AuthError } from './auth.js';
import { requirePaid } from './plan-gate.js';
import { rateLimit } from './rate-limit.js';
import { guardPublicTarget } from './target-guard.js';
import type { HttpResult } from './createScan.js';

/**
 * POST /createDeepScan (auth required) — white-box scan of the caller's own
 * connected GitHub repo and/or Supabase project. Requires an active connection
 * for each requested source. Never runs the scan inline (the worker does).
 */
export async function handleCreateDeepScan(
  rawBody: unknown,
  queue: Queue,
  authHeader: string | undefined,
): Promise<HttpResult> {
  let uid: string;
  try {
    uid = (await requireAuth(authHeader)).uid;
  } catch (e) {
    if (e instanceof AuthError) return { status: e.status, body: { error: e.message } };
    throw e;
  }

  // PRO-only. Free plan scans URLs (black-box) only; deep/white-box is paid.
  if (!(await requirePaid(uid))) {
    return { status: 402, body: { error: 'Deep scan is a Pro feature — upgrade to scan your connected code.' } };
  }

  const body = (rawBody ?? {}) as { github?: boolean; githubRepo?: string; supabase?: boolean; url?: string };
  // Choosing a specific repo implies a GitHub source.
  const wantsGithub = !!body.github || !!body.githubRepo;
  const sources: { github: boolean; githubRepo?: string; supabase: boolean; url?: string } = {
    github: wantsGithub,
    githubRepo: body.githubRepo,
    supabase: !!body.supabase,
    url: body.url,
  };
  if (!sources.github && !sources.supabase && !sources.url) {
    return { status: 400, body: { error: 'select at least one source: github, supabase, or url' } };
  }

  // Each requested connected source must actually be connected by THIS user.
  if (sources.github && !(await hasConnection(uid, 'github'))) {
    return { status: 409, body: { error: 'GitHub is not connected — connect a repo first' } };
  }
  // If a specific repo was chosen, verify it's one the user's installation can
  // actually access — never let a client scan an arbitrary repo. (Skipped in
  // mock mode, which has a single fixture repo and no real installation.)
  if (sources.githubRepo && !config.mockConnections) {
    const blob = await getEncryptedSecret(uid, 'github');
    const secret = blob ? decryptJson<GitHubSecret>(blob) : null;
    if (!secret || secret.mock) {
      return { status: 409, body: { error: 'GitHub is not connected — connect it in Settings first' } };
    }
    try {
      if (!(await installationHasRepo(secret.installationId, sources.githubRepo))) {
        return { status: 400, body: { error: 'that repository is not available to your GitHub connection' } };
      }
    } catch {
      return { status: 502, body: { error: 'could not verify the repository with GitHub — try again' } };
    }
  }
  if (sources.supabase && !(await hasConnection(uid, 'supabase'))) {
    return { status: 409, body: { error: 'Supabase is not connected — connect a project first' } };
  }
  if (sources.url) {
    const g = guardPublicTarget({ type: 'url', value: sources.url }, false);
    if (!g.ok) return { status: 400, body: { error: g.error } };
  }

  // Rate limit deep scans per user (they're expensive).
  const rl = rateLimit(`deep|${uid}`);
  if (!rl.allowed) return { status: 429, body: { error: 'rate limited', retryAfterMs: rl.retryAfterMs } };

  // Monthly scan cap (Guard = 30). Manual deep/upload + monitoring re-scans and
  // URL scans all share this per-plan pool. Apps are unlimited.
  const plan = await getPlan(uid);
  if (!(await canScan(uid, plan))) {
    const n = scanLimit(plan);
    return { status: 429, body: { error: `Monthly scan limit reached (${n}/${n}). It resets next cycle — reach out if you need a higher limit.`, code: 'E_SCAN_LIMIT' } };
  }

  const scanId = await createDeepScanDoc(uid, sources);
  await queue.enqueue({ scanId });
  return { status: 202, body: { scanId } };
}
