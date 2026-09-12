import { createUploadScanDoc, getPlanAndComp, newScanId } from '../../shared/src/firestore.js';
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
 * Upload flow (PRO-only white-box scan of a folder the user zips in the browser).
 * Two steps so the zip streams BROWSER→GCS directly and isn't bounded by Cloud
 * Run's ~32MB request cap — hence "any size":
 *
 *   1) POST /createUploadSession { name } → all the gates (auth, paid, rate-limit,
 *      monthly cap) up-front, then mint a resumable upload URL and return
 *      { scanId, uploadUrl }. No scan doc yet.
 *   2) browser PUTs the zip straight to uploadUrl (GCS in prod).
 *   3) POST /finalizeUploadScan { scanId, name } → verify the staged object,
 *      create the queued doc, enqueue. The worker extracts + wipes it.
 */
export async function handleCreateUploadSession(
  name: string | undefined,
  origin: string,
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

  // Upload scans are expensive (extract + full white-box) — rate-limit per user.
  const rl = rateLimit(`upload|${uid}`);
  if (!rl.allowed) return { status: 429, body: { error: 'rate limited', retryAfterMs: rl.retryAfterMs } };

  // Monthly scan cap (Guard = 30) — shared across every scan type. Apps unlimited.
  const { plan, comp } = await getPlanAndComp(uid);
  if (!(await canScan(uid, plan, comp))) {
    const n = effectiveScanLimit(plan, comp);
    return { status: 429, body: { error: `Monthly scan limit reached (${n}/${n}). It resets next cycle — reach out if you need a higher limit.`, code: 'E_SCAN_LIMIT' } };
  }

  const scanId = newScanId();
  let uploadUrl: string;
  try {
    uploadUrl = await makeStaging().createUploadSession(scanId, origin);
  } catch (e) {
    console.error('[upload] could not create upload session:', e);
    return { status: 500, body: { error: 'could not start the upload — try again' } };
  }
  return { status: 200, body: { scanId, uploadUrl } };
}

/**
 * POST /finalizeUploadScan — called after the browser has uploaded the zip to the
 * session URL. Verifies the staged object exists, is within the safety ceiling,
 * and is really a zip; then creates the queued doc + enqueues. `scanId` is an
 * unguessable id we minted for this caller, so it can't finalize another user's
 * in-flight object.
 */
export async function handleFinalizeUploadScan(
  scanId: string | undefined,
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
  if (!(await requirePaid(uid))) {
    return { status: 402, body: { error: 'Folder upload is a Pro feature — upgrade to scan uploaded code.' } };
  }
  if (!scanId || typeof scanId !== 'string') {
    return { status: 400, body: { error: 'missing scanId' } };
  }

  const staging = makeStaging();
  let size: number;
  let head: Buffer;
  try {
    size = await staging.size(scanId);
    head = await staging.head(scanId, 4);
  } catch {
    return { status: 400, body: { error: 'we didn’t receive your upload — please try again' } };
  }
  if (size === 0) {
    await staging.delete(scanId).catch(() => {});
    return { status: 400, body: { error: 'the upload was empty — please try again' } };
  }
  if (size > config.uploadMaxBytes) {
    await staging.delete(scanId).catch(() => {});
    return { status: 413, body: { error: `upload too large (max ${Math.floor(config.uploadMaxBytes / 1024 / 1024 / 1024)}GB)` } };
  }
  if (!looksLikeZip(head)) {
    await staging.delete(scanId).catch(() => {});
    return { status: 400, body: { error: 'that file isn’t a valid .zip — try re-zipping your folder' } };
  }

  const name0 = safeName(name);
  await createUploadScanDoc(uid, { name: name0 }, {}, scanId);
  await queue.enqueue({ scanId });
  return { status: 202, body: { scanId } };
}
