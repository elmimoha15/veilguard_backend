import { setPlan } from '../../shared/src/firestore.js';
import { config } from '../../shared/src/config.js';
import type { Plan } from '../../shared/src/types.js';
import { requireAuth, AuthError } from './auth.js';
import type { HttpResult } from './createScan.js';

const PLANS: readonly Plan[] = ['free', 'guard', 'fixpack'];
function isPlan(v: unknown): v is Plan {
  return typeof v === 'string' && (PLANS as readonly string[]).includes(v);
}

async function withUid(authHeader: string | undefined, fn: (uid: string) => Promise<HttpResult>): Promise<HttpResult> {
  try {
    const { uid } = await requireAuth(authHeader);
    return await fn(uid);
  } catch (e) {
    if (e instanceof AuthError) return { status: e.status, body: { error: e.message } };
    throw e;
  }
}

/**
 * POST /billing/checkout { plan } — begin an upgrade. Today (fake mode) it just
 * echoes `{ mode: 'fake', plan }` and the client shows a test-confirm step, then
 * calls /billing/confirm. Polar seam: when `config.polarConfigured`, create a
 * hosted checkout session and return `{ mode: 'polar', url }` for the client to
 * redirect to (the plan is then granted by the Polar webhook, not /confirm).
 */
export async function handleStartCheckout(rawBody: unknown, authHeader: string | undefined): Promise<HttpResult> {
  return withUid(authHeader, async () => {
    const plan = (rawBody as { plan?: string })?.plan;
    if (!isPlan(plan)) return { status: 400, body: { error: 'invalid plan' } };
    // TODO(Polar): if (config.polarConfigured) return { status: 200, body: { mode: 'polar', url: await createPolarCheckout(uid, plan) } };
    return { status: 200, body: { mode: 'fake', plan } };
  });
}

/**
 * POST /billing/confirm { plan } — FAKE upgrade: grant the plan without payment.
 * Guarded by `config.fakeBilling` (403 otherwise) so it can never grant a plan in
 * production, where the Polar webhook is the sole authority. Server-authoritative:
 * clients cannot write `plan` directly (firestore.rules).
 */
export async function handleConfirmUpgrade(rawBody: unknown, authHeader: string | undefined): Promise<HttpResult> {
  return withUid(authHeader, async (uid) => {
    if (!config.fakeBilling) {
      return { status: 403, body: { error: 'fake billing is disabled — real checkout is required' } };
    }
    const plan = (rawBody as { plan?: string })?.plan;
    if (!isPlan(plan)) return { status: 400, body: { error: 'invalid plan' } };
    await setPlan(uid, plan);
    return { status: 200, body: { plan } };
  });
}
