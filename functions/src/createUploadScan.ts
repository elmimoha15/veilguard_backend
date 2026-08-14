import { createUploadScanDoc, getPlanAndComp } from '../../shared/src/firestore.js';
import { makeStaging } from '../../shared/src/staging.js';
import { config } from '../../shared/src/config.js';
import type { Queue } from '../../shared/src/queue.js';
import { canScan, effectiveScanLimit } from '../../shared/src/usage.js';
import { requireAuth, AuthError } from './auth.js';
import { requirePaid } from './plan-gate.js';
import { rateLimit } from './rate-limit.js';
import type { HttpResult } from './createScan.js';

/** A .zip starts with a PK local-file/central-dir/spanned header. */
function looksLikeZip(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  const [a, b, c, d] = buf;
  return a === 0x50 && b === 0x4b && (c === 0x03 || c === 0x05 || c === 0x07) && (d === 0x04 || d === 0x06 || d === 0x08);
}

/** Turn an arbitrary folder name into a short, safe display label. */
function safeName(raw: string | undefined): string {
  const base = (raw ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 60);
  return cleaned || 'upload';
}

/**
 * POST /createUploadScan (auth required, PRO-only) — white-box scan of a folder
 * the user uploaded as a single .zip. Mirrors createDeepScan, but the source is
 * staged (StagingStore) instead of cloned; the worker extracts + wipes it. Thin
 * by design: auth → paid-gate → rate-limit → validate zip → stage → queued doc →
 * enqueue. Never runs the scan (the worker does).
 */
export async function handleCreateUploadScan(
  rawZip: unknown,
  name: string | undefined,
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

  // PRO-only. Free plan scans URLs, not code.
  if (!(await requirePaid(uid))) {
    return { status: 402, body: { error: 'Folder upload is a Pro feature — upgrade to scan uploaded code.' } };
  }

  if (!Buffer.isBuffer(rawZip) || rawZip.length === 0) {
    return { status: 400, body: { error: 'expected a non-empty .zip body (content-type: application/zip)' } };
  }
  if (rawZip.length > config.uploadMaxBytes) {
    return { status: 413, body: { error: `upload too large (max ${Math.floor(config.uploadMaxBytes / 1024 / 1024)}MB)` } };
  }
  if (!looksLikeZip(rawZip)) {
    return { status: 400, body: { error: 'body is not a valid .zip archive' } };
  }

  // Upload scans are expensive (extract + full white-box) — rate-limit per user.
  const rl = rateLimit(`upload|${uid}`);
  if (!rl.allowed) return { status: 429, body: { error: 'rate limited', retryAfterMs: rl.retryAfterMs } };

  // Monthly scan cap (Guard = 30) — shared across every scan type. Apps unlimited.
  const name0 = safeName(name);
  const { plan, comp } = await getPlanAndComp(uid);
  if (!(await canScan(uid, plan, comp))) {
    const n = effectiveScanLimit(plan, comp);
    return { status: 429, body: { error: `Monthly scan limit reached (${n}/${n}). It resets next cycle — reach out if you need a higher limit.`, code: 'E_SCAN_LIMIT' } };
  }

  const scanId = await createUploadScanDoc(uid, { name: name0 });
  try {
    await makeStaging().put(scanId, rawZip);
  } catch {
    return { status: 500, body: { error: 'could not stage the upload — try again' } };
  }
  await queue.enqueue({ scanId });
  return { status: 202, body: { scanId } };
}
