import { Webhook, WebhookVerificationError } from 'standardwebhooks';
import { config } from '../../shared/src/config.js';
import { getDb, getUser, setBilling } from '../../shared/src/firestore.js';
import { sendGuardActivated, sendPaymentFailed, sendSubscriptionCanceled } from '../../shared/src/emails/senders.js';
import type { HttpResult } from './createScan.js';

/**
 * Raw Polar subscription payload (snake_case, straight off the wire — we verify
 * the signature ourselves via standard-webhooks and read the JSON directly, so
 * fields are NOT camelCased). Only the fields we use are typed.
 */
interface PolarSub {
  id: string;
  status?: string;
  current_period_end?: string | null;
  cancel_at_period_end?: boolean;
  product_id?: string;
  customer_id?: string | null;
  customer?: { id?: string; external_id?: string | null; email?: string | null };
  metadata?: Record<string, unknown>;
}

/** Normalize Express headers (string | string[]) to the Record<string,string> verify() wants. */
export function flattenHeaders(h: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v[0] ?? '' : v;
  }
  return out;
}

/** Polar signs webhooks with standard-webhooks using a base64 of the secret. */
function verifier(): Webhook {
  return new Webhook(Buffer.from(config.polarWebhookSecret, 'utf-8').toString('base64'));
}

function uidOf(sub: PolarSub): string | undefined {
  return sub.customer?.external_id ?? (typeof sub.metadata?.uid === 'string' ? (sub.metadata.uid as string) : undefined);
}

/**
 * POST /polarWebhook — THE source of truth for plan changes. Nothing else may
 * grant/revoke a plan. Verifies the standard-webhooks signature, dedupes by the
 * delivery id (idempotent), then maps the Polar subscription lifecycle onto
 * users/{uid}. `plan` stays 'guard' through grace + a scheduled cancel and drops
 * to 'free' only on revoke — so `canUseMonitoring`/fix access (keyed on `plan`)
 * follow automatically.
 */
export async function handlePolarWebhook(rawBody: Buffer, headers: Record<string, string>): Promise<HttpResult> {
  if (!config.polarConfigured) {
    return { status: 200, body: { ignored: 'polar-not-configured' } };
  }

  // 1) Verify signature (standard-webhooks). Unverified → 401.
  let event: { type?: string; data?: PolarSub };
  try {
    event = verifier().verify(rawBody.toString('utf8'), headers) as { type?: string; data?: PolarSub };
  } catch (e) {
    if (e instanceof WebhookVerificationError) return { status: 401, body: { error: 'invalid signature' } };
    throw e;
  }

  const type = event.type ?? '';

  // 2) Idempotency — the delivery id (`webhook-id`) is unique per delivery.
  //    Record it transactionally; a duplicate is a no-op.
  const deliveryId = headers['webhook-id'];
  if (deliveryId) {
    const ref = getDb().collection('billingEvents').doc(deliveryId);
    const fresh = await getDb().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) return false;
      tx.set(ref, { type, at: new Date().toISOString() });
      return true;
    });
    if (!fresh) return { status: 200, body: { deduped: true } };
  }

  // 3) Only subscription.* events move the plan; one-time order.* are ignored.
  if (!type.startsWith('subscription.')) return { status: 200, body: { ignored: type } };

  const sub = event.data;
  const uid = sub && uidOf(sub);
  if (!sub || !uid) {
    console.error('[polarWebhook] no uid on', type);
    return { status: 200, body: { ignored: 'no-uid' } };
  }

  const periodEnd = sub.current_period_end ? String(sub.current_period_end) : undefined;
  // Polar subscription payloads carry the customer both nested and as top-level
  // `customer_id`; prefer the nested id, fall back to the flat one so we always
  // capture it (needed for the portal, and as a convenience on deletion).
  const customerId = sub.customer?.id ?? (sub.customer_id ? String(sub.customer_id) : undefined);
  const emailTo = (await getUser(uid))?.email ?? sub.customer?.email ?? undefined;

  switch (type) {
    case 'subscription.created':
    case 'subscription.active':
      await setBilling(uid, { plan: 'guard', status: 'active', subscriptionId: sub.id, polarCustomerId: customerId, currentPeriodEnd: periodEnd, cancelAtPeriodEnd: false });
      if (type === 'subscription.active' && emailTo) void sendGuardActivated(emailTo).catch((e) => console.error('[polarWebhook] activated email:', e));
      break;
    case 'subscription.updated':
    case 'subscription.cycled':
      // Renewal / generic change — keep guard, refresh period + cancel flag. No email.
      await setBilling(uid, { plan: 'guard', status: 'active', subscriptionId: sub.id, polarCustomerId: customerId, currentPeriodEnd: periodEnd, cancelAtPeriodEnd: !!sub.cancel_at_period_end });
      break;
    case 'subscription.past_due':
      // Payment failed — KEEP access during Polar's dunning/grace. Nudge by email.
      await setBilling(uid, { plan: 'guard', status: 'past_due', currentPeriodEnd: periodEnd });
      if (emailTo) void sendPaymentFailed(emailTo).catch((e) => console.error('[polarWebhook] payment-failed email:', e));
      break;
    case 'subscription.canceled':
      // Scheduled cancel — KEEP guard until currentPeriodEnd; revoke fires later.
      await setBilling(uid, { plan: 'guard', status: 'canceled', cancelAtPeriodEnd: true, currentPeriodEnd: periodEnd });
      if (emailTo) void sendSubscriptionCanceled(emailTo, periodEnd ? new Date(periodEnd).toLocaleDateString() : undefined).catch((e) => console.error('[polarWebhook] canceled email:', e));
      break;
    case 'subscription.uncanceled':
      await setBilling(uid, { plan: 'guard', status: 'active', cancelAtPeriodEnd: false, currentPeriodEnd: periodEnd });
      break;
    case 'subscription.revoked':
      // Access truly ends — downgrade to free. Monitoring + fixes auto-lock.
      await setBilling(uid, { plan: 'free', status: 'expired', cancelAtPeriodEnd: false });
      break;
    default:
      return { status: 200, body: { ignored: type } };
  }

  return { status: 200, body: { ok: true } };
}
