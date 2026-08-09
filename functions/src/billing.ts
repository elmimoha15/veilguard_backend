import { config } from '../../shared/src/config.js';
import { getUser } from '../../shared/src/firestore.js';
import {
  createGuardCheckout,
  createPortalUrl,
  resolvePolarCustomerId,
  listOrders,
  getInvoiceUrl,
  getActiveSubscriptionId,
  setSubscriptionCancel,
  isConnectionError,
} from '../../shared/src/polar.js';
import { requireAuth, AuthError } from './auth.js';
import type { HttpResult } from './createScan.js';

async function withUid(authHeader: string | undefined, fn: (uid: string, email?: string) => Promise<HttpResult>): Promise<HttpResult> {
  try {
    const { uid, email } = await requireAuth(authHeader);
    return await fn(uid, email);
  } catch (e) {
    if (e instanceof AuthError) return { status: e.status, body: { error: e.message } };
    throw e;
  }
}

/**
 * Only allow returning to an in-app relative path (open-redirect guard): must
 * start with a single '/', and not '//' (protocol-relative) or contain a scheme.
 */
function safeNext(next: unknown): string {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//') || next.includes('://')) {
    return '/dashboard';
  }
  return next;
}

/**
 * POST /createCheckout { next? } — start a real Polar checkout for the Guard
 * subscription. The uid is attached to the checkout (externalCustomerId +
 * metadata) so the webhook can grant the plan. `next` (a validated in-app path)
 * is carried on the success URL so we return the user to where they upgraded
 * from. Returns `{ url }` to redirect to. The plan is NEVER granted here.
 */
export async function handleCreateCheckout(rawBody: unknown, authHeader: string | undefined): Promise<HttpResult> {
  return withUid(authHeader, async (uid, email) => {
    if (!config.polarConfigured || config.guardProductIds.length === 0) {
      return { status: 503, body: { error: 'billing is not configured' } };
    }
    const next = safeNext((rawBody as { next?: unknown })?.next);
    // Return to where the APP is served (FRONTEND_URL) — localhost:3000 in dev,
    // the app origin in prod — NOT the email/marketing base (APP_BASE_URL).
    const successUrl = `${config.frontendUrl}/billing/success?next=${encodeURIComponent(next)}`;
    try {
      const url = await createGuardCheckout(uid, email, successUrl);
      return { status: 200, body: { url } };
    } catch (e) {
      console.error('[billing] createCheckout failed:', e);
      return { status: 502, body: { error: 'could not start checkout' } };
    }
  });
}

/**
 * POST /billingPortal — hosted Polar customer portal (update card, cancel, view
 * invoices). Requires the user to already be a Polar customer (set by the webhook
 * on first subscription). 409 if they have no billing customer yet.
 */
export async function handleBillingPortal(authHeader: string | undefined): Promise<HttpResult> {
  return withUid(authHeader, async (uid) => {
    if (!config.polarConfigured) return { status: 503, body: { error: 'billing is not configured' } };
    const user = await getUser(uid);
    // Prefer the stored id; fall back to resolving it by external id (= uid) for
    // subscribers whose id we never captured on the webhook.
    const customerId = user?.polarCustomerId ?? (await resolvePolarCustomerId(uid)) ?? undefined;
    if (!customerId) return { status: 409, body: { error: 'no billing account yet — subscribe first' } };
    try {
      const url = await createPortalUrl(customerId, `${config.frontendUrl}/billing`);
      return { status: 200, body: { url } };
    } catch (e) {
      console.error('[billing] portal failed:', e);
      return { status: 502, body: { error: 'could not open billing portal' } };
    }
  });
}

/**
 * POST /billingTransactions — the caller's billing history (orders), newest
 * first, looked up by external id (= uid). Free users / no orders → empty list.
 */
export async function handleListTransactions(authHeader: string | undefined): Promise<HttpResult> {
  return withUid(authHeader, async (uid) => {
    if (!config.polarConfigured) return { status: 200, body: { transactions: [] } };
    try {
      const transactions = await listOrders(uid);
      return { status: 200, body: { transactions } };
    } catch (e) {
      // Can't reach Polar (timeout/unreachable) → degrade to an empty history
      // rather than a hard error; the page still renders. Log one concise line.
      if (isConnectionError(e)) {
        console.warn('[billing] list transactions: Polar unreachable — showing empty history');
        return { status: 200, body: { transactions: [], degraded: true } };
      }
      console.error('[billing] list transactions failed:', e instanceof Error ? e.message : e);
      return { status: 502, body: { error: 'could not load billing history' } };
    }
  });
}

/**
 * POST /billingInvoice { orderId } — a downloadable invoice URL for one of the
 * caller's orders. Ownership is enforced: the orderId MUST belong to this uid
 * (it must appear in the caller's own order list) — otherwise 404, so a user can
 * never fetch someone else's invoice. `pending` (202) means Polar is still
 * generating the PDF; the client retries shortly.
 */
export async function handleInvoiceUrl(rawBody: unknown, authHeader: string | undefined): Promise<HttpResult> {
  return withUid(authHeader, async (uid) => {
    if (!config.polarConfigured) return { status: 503, body: { error: 'billing is not configured' } };
    const orderId = (rawBody as { orderId?: unknown })?.orderId;
    if (typeof orderId !== 'string' || !orderId) return { status: 400, body: { error: 'orderId required' } };
    try {
      const owned = (await listOrders(uid)).some((t) => t.id === orderId);
      if (!owned) return { status: 404, body: { error: 'invoice not found' } };
      const res = await getInvoiceUrl(orderId);
      if (res.url) return { status: 200, body: { url: res.url } };
      return { status: 202, body: { pending: true } };
    } catch (e) {
      console.error('[billing] invoice failed:', e);
      return { status: 502, body: { error: 'could not get invoice' } };
    }
  });
}

/** Shared cancel/resume: resolve the caller's subscription and flip cancelAtPeriodEnd. */
async function setCancel(uid: string, cancelAtPeriodEnd: boolean): Promise<HttpResult> {
  if (!config.polarConfigured) return { status: 503, body: { error: 'billing is not configured' } };
  try {
    const subId = await getActiveSubscriptionId(uid, (await getUser(uid))?.subscriptionId);
    if (!subId) return { status: 409, body: { error: 'no active subscription' } };
    // Call Polar only; the resulting subscription.* webhook is what persists the
    // new state to Firestore (webhook = sole plan authority).
    await setSubscriptionCancel(subId, cancelAtPeriodEnd);
    return { status: 200, body: { ok: true } };
  } catch (e) {
    console.error('[billing] set-cancel failed:', e);
    return { status: 502, body: { error: cancelAtPeriodEnd ? 'could not cancel subscription' : 'could not resume subscription' } };
  }
}

/** POST /billingCancel — schedule cancellation at period end (keeps access until then). */
export async function handleCancelSubscription(authHeader: string | undefined): Promise<HttpResult> {
  return withUid(authHeader, (uid) => setCancel(uid, true));
}

/** POST /billingReactivate — reverse a scheduled cancellation. */
export async function handleReactivateSubscription(authHeader: string | undefined): Promise<HttpResult> {
  return withUid(authHeader, (uid) => setCancel(uid, false));
}
