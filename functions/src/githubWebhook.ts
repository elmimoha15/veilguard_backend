import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../../shared/src/config.js';
import { getDb } from '../../shared/src/firestore.js';
import type { Queue } from '../../shared/src/queue.js';
import { listMonitoredApps, getMonitorRun, enqueueMonitorScan, markPushEnqueued } from '../../shared/src/monitor.js';
import type { HttpResult } from './createScan.js';

/**
 * Verify the GitHub webhook signature (X-Hub-Signature-256 = "sha256=" + HMAC-
 * SHA256(secret, rawBody)). Constant-time. Returns false on any missing/garbled
 * input — we reject rather than trust. (We flag this exact bug in other people's
 * code, so ours verifies for real.)
 */
export function verifySignature(rawBody: Buffer, signature: string | undefined): boolean {
  const secret = config.githubWebhookSecret;
  if (!secret || !signature || !signature.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * POST /githubWebhook — deploy-triggered re-scans. On a VERIFIED push, enqueue a
 * deep scan for every monitored (cadence:'push') app whose repo matches, for the
 * users who actually connected it. Unverified/spoofed → 401, nothing enqueued.
 * Debounced per app so a burst of pushes can't stampede.
 */
export async function handleGitHubWebhook(
  rawBody: Buffer,
  headers: { signature?: string; event?: string; deliveryId?: string },
  queue: Queue,
  now = Date.now(),
): Promise<HttpResult> {
  if (!verifySignature(rawBody, headers.signature)) {
    return { status: 401, body: { error: 'invalid signature' } };
  }
  // Signature is valid; only act on push events (ack pings/others).
  if (headers.event && headers.event !== 'push') {
    return { status: 200, body: { ignored: headers.event } };
  }

  // Idempotency: GitHub retries deliveries. Record the delivery id (X-GitHub-
  // Delivery) transactionally so a replay is a no-op — the debounce below only
  // covers replays within its window, not a retry hours later. (Mirror Polar.)
  const deliveryId = headers.deliveryId;
  if (deliveryId) {
    const ref = getDb().collection('webhookDeliveries').doc(deliveryId);
    const fresh = await getDb().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) return false;
      tx.set(ref, { source: 'github', at: new Date(now).toISOString() });
      return true;
    });
    if (!fresh) return { status: 200, body: { deduped: true } };
  }

  let repo = '';
  try {
    const payload = JSON.parse(rawBody.toString('utf8')) as { repository?: { full_name?: string } };
    repo = (payload.repository?.full_name ?? '').toLowerCase();
  } catch {
    return { status: 400, body: { error: 'invalid payload' } };
  }
  if (!repo) return { status: 200, body: { ignored: 'no-repo' } };

  const monitored = await listMonitoredApps();
  const matches = monitored.filter(
    (m) => m.app.monitoring!.cadence === 'push' && (m.app.githubRepo ?? '').toLowerCase() === repo,
  );

  const enqueued: { uid: string; appId: string; scanId: string }[] = [];
  for (const { uid, app } of matches) {
    // Debounce: ignore repeated pushes to the same app within the window.
    const run = await getMonitorRun(uid, app.id);
    if (run?.lastPushEnqueuedAt && now - new Date(run.lastPushEnqueuedAt).getTime() < config.monitorPushDebounceMs) {
      continue;
    }
    const scanId = await enqueueMonitorScan(uid, app, queue);
    if (scanId) {
      await markPushEnqueued(uid, app.id);
      enqueued.push({ uid, appId: app.id, scanId });
    }
  }

  return { status: 202, body: { repo, enqueued } };
}
