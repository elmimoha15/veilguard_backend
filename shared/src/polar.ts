import { Polar } from '@polar-sh/sdk';
import { config } from './config.js';

/**
 * Lazily-constructed Polar SDK client (sandbox or production per POLAR_SERVER).
 * Kept behind a getter so importing this module never throws when Polar isn't
 * configured (tests that only exercise the webhook mock the network anyway).
 */
let client: Polar | null = null;
export function polar(): Polar {
  if (!client) {
    client = new Polar({
      accessToken: config.polarAccessToken,
      server: config.polarServer,
      // Fail fast + don't retry connection errors: an unreachable Polar (e.g. no
      // outbound network in local dev) should error in seconds, not hang while
      // the SDK backs off and re-dials. Real HTTP hiccups (429/5xx) still retry.
      timeoutMs: config.polarTimeoutMs,
      retryConfig: {
        strategy: 'backoff',
        backoff: { initialInterval: 500, maxInterval: 2000, exponent: 1.5, maxElapsedTime: 6000 },
        retryConnectionErrors: false,
      },
    });
  }
  return client;
}

/** Test seam: inject a fake Polar client (checkout/portal) so tests never hit the network. */
export function setPolarClient(c: Polar | null): void {
  client = c;
}

/**
 * A network-level failure reaching Polar (timeout / DNS / refused / unreachable)
 * — as opposed to a real API response. Read endpoints degrade gracefully on
 * these (show empty) instead of surfacing a hard error to the user.
 */
export function isConnectionError(e: unknown): boolean {
  if (!e) return false;
  const name = (e as { name?: string }).name ?? '';
  if (name === 'ConnectionError' || name === 'RequestTimeoutError' || name === 'AbortError') return true;
  const codeOf = (x: unknown): string => String((x as { code?: unknown })?.code ?? '');
  const codes = new Set(['ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);
  // Walk the cause chain (SDK ConnectionError → TypeError: fetch failed → AggregateError).
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur; i++) {
    if (codes.has(codeOf(cur))) return true;
    const errs = (cur as { errors?: unknown[] }).errors;
    if (Array.isArray(errs) && errs.some((x) => codes.has(codeOf(x)))) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Create a hosted Guard-subscription checkout for `uid`. The uid is attached as
 * `externalCustomerId` + metadata so the webhook can map the resulting
 * subscription back to our user. Returns the hosted checkout URL.
 */
export async function createGuardCheckout(uid: string, email: string | undefined, successUrl: string): Promise<string> {
  const co = await polar().checkouts.create({
    products: config.guardProductIds,
    externalCustomerId: uid,
    ...(email ? { customerEmail: email } : {}),
    successUrl,
    metadata: { uid },
  });
  return co.url;
}

/**
 * Create a Polar customer-portal session URL (update payment method). `returnUrl`
 * (our in-app billing page) gives the hosted portal a "back to app" link so the
 * user is never stranded on Polar.
 */
export async function createPortalUrl(customerId: string, returnUrl?: string): Promise<string> {
  const s = await polar().customerSessions.create({ customerId, ...(returnUrl ? { returnUrl } : {}) });
  return s.customerPortalUrl;
}

/**
 * Delete a Polar customer — cancels their subscription(s) and removes them from
 * the customer list, so re-signing-up with the same email doesn't hit "you
 * already have an active subscription". Used on account deletion.
 */
export async function deletePolarCustomer(customerId: string): Promise<void> {
  await polar().customers.delete({ id: customerId });
}

/** True for a Polar 404 (ResourceNotFound) — i.e. no such customer. */
function isNotFound(e: unknown): boolean {
  const err = e as { error?: string; name?: string; httpMeta?: { response?: { status?: number } } };
  return err?.error === 'ResourceNotFound' || err?.name === 'ResourceNotFound' || err?.httpMeta?.response?.status === 404;
}

/**
 * Delete a Polar customer BY OUR external id (= the Firebase uid, set as
 * `externalCustomerId` at checkout). This is the robust deletion path: it needs
 * no stored `polarCustomerId`, so it works even for customers whose id we never
 * captured. Returns true if a customer was deleted, false if there was none
 * (a free user who never subscribed → clean no-op, not an error).
 */
export async function deletePolarCustomerByExternalId(externalId: string): Promise<boolean> {
  try {
    await polar().customers.deleteExternal({ externalId });
    return true;
  } catch (e) {
    if (isNotFound(e)) return false;
    throw e;
  }
}

/** Resolve a Polar customer id from our external id (uid); null if none exists. */
export async function resolvePolarCustomerId(externalId: string): Promise<string | null> {
  try {
    const c = await polar().customers.getExternal({ externalId });
    return c.id;
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/** A billing transaction shaped for the client (money in integer cents). */
export interface NormalizedTxn {
  id: string;
  date: string; // ISO
  amount: number; // cents
  currency: string;
  status: string;
  paid: boolean;
  reason: string; // Polar billingReason (subscription_create | subscription_cycle | …)
  invoiceNumber: string | null;
  hasInvoice: boolean; // an invoice PDF has already been generated
}

/**
 * List a customer's orders (transactions) BY external id (= uid), newest first.
 * Empty for a user with no Polar customer / no orders (never throws on 404).
 */
export async function listOrders(externalId: string, limit = 50): Promise<NormalizedTxn[]> {
  try {
    const { result } = await polar().orders.list({ externalCustomerId: externalId, limit });
    return result.items
      .map((o) => ({
        id: o.id,
        date: (o.createdAt instanceof Date ? o.createdAt.toISOString() : String(o.createdAt)),
        amount: o.totalAmount,
        currency: o.currency,
        status: o.status,
        paid: o.paid,
        reason: String(o.billingReason),
        invoiceNumber: o.invoiceNumber ?? null,
        hasInvoice: o.isInvoiceGenerated,
      }))
      .sort((a, b) => b.date.localeCompare(a.date));
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
  }
}

/**
 * Get a downloadable (hosted PDF) invoice URL for an order. Polar generates
 * invoices lazily: if one doesn't exist yet we trigger generation (async) and
 * report `pending` so the caller can retry shortly.
 */
export async function getInvoiceUrl(orderId: string): Promise<{ url?: string; pending?: boolean }> {
  const order = await polar().orders.get({ id: orderId });
  if (!order.isInvoiceGenerated) {
    await polar().orders.generateInvoice({ id: orderId });
    return { pending: true };
  }
  const { url } = await polar().orders.invoice({ id: orderId });
  return { url };
}

/**
 * Resolve the caller's active subscription id: prefer the id we stored from the
 * webhook, else look it up by external id (= uid). Null if none is active.
 */
export async function getActiveSubscriptionId(externalId: string, storedId?: string): Promise<string | null> {
  if (storedId) return storedId;
  try {
    const { result } = await polar().subscriptions.list({ externalCustomerId: externalId, active: true, limit: 1 });
    return result.items[0]?.id ?? null;
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/**
 * Schedule (or reverse) a cancellation at period end. `true` cancels — the
 * customer keeps Guard until currentPeriodEnd, then Polar revokes it; `false`
 * uncancels a scheduled cancellation. Plan state is persisted by the resulting
 * subscription.* webhook, never here.
 */
export async function setSubscriptionCancel(subscriptionId: string, cancelAtPeriodEnd: boolean): Promise<void> {
  await polar().subscriptions.update({ id: subscriptionId, subscriptionUpdate: { cancelAtPeriodEnd } });
}
