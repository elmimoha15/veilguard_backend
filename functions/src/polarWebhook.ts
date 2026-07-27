import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../../shared/src/config.js';
import type { HttpResult } from './createScan.js';

/**
 * Verify a Polar webhook signature (HMAC-SHA256 of the raw body with the webhook
 * secret). Constant-time, fail-closed — mirrors githubWebhook.ts. The exact
 * header/format is finalized when wiring real Polar; kept generic for now.
 */
export function verifyPolarSignature(rawBody: Buffer, signature: string | undefined): boolean {
  const secret = config.polarWebhookSecret;
  if (!secret || !signature) return false;
  const provided = signature.replace(/^sha256=/, '').trim();
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * POST /polarWebhook — STUB for real Polar billing. Inert until Polar is
 * configured (`POLAR_WEBHOOK_SECRET` + `POLAR_ACCESS_TOKEN`); returns `ignored`
 * so it's safe to deploy now. When wired for real it will: verify the signature,
 * parse a subscription/checkout event, resolve the uid (from the checkout
 * metadata we attach at session creation) and the product→plan mapping, then call
 * `setPlan(uid, plan)` — the SAME server seam the fake /billing/confirm uses.
 */
export async function handlePolarWebhook(rawBody: Buffer, signature: string | undefined): Promise<HttpResult> {
  if (!config.polarConfigured) {
    return { status: 200, body: { ignored: 'polar-not-configured' } };
  }
  if (!verifyPolarSignature(rawBody, signature)) {
    return { status: 401, body: { error: 'invalid signature' } };
  }
  // TODO(Polar): parse event → resolve uid + plan → setPlan(uid, plan).
  return { status: 202, body: { received: true } };
}
