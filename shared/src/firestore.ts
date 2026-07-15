import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { findingId as engineFindingId } from 'veilguard-scanner';
import { config } from './config.js';
import type { Finding, ScanDoc, ScanProgress, ScanStatus, Target, UserDoc } from './types.js';

let db: Firestore | null = null;

/** Lazily initialize the Admin SDK + Firestore. Emulator-aware (no creds needed). */
export function getDb(): Firestore {
  if (db) return db;
  if (getApps().length === 0) {
    // On the emulator (FIRESTORE_EMULATOR_HOST set) no credentials are required.
    // In prod, Application Default Credentials are used automatically.
    initializeApp({ projectId: config.projectId });
  }
  db = getFirestore();
  db.settings({ ignoreUndefinedProperties: true });
  return db;
}

const scanRef = (id: string) => getDb().collection('scans').doc(id);
const findingsRef = (id: string) => scanRef(id).collection('findings');
const userRef = (uid: string) => getDb().collection('users').doc(uid);

function nowIso(): string {
  return new Date().toISOString();
}

/** Create a `scans/{id}` doc in status "queued". ownerUid null = anonymous. */
export async function createScanDoc(target: Target, ownerUid: string | null = null): Promise<string> {
  const ref = getDb().collection('scans').doc();
  const doc: ScanDoc = {
    id: ref.id,
    target,
    ownerUid,
    status: 'queued',
    createdAt: nowIso(),
  };
  await ref.set(doc);
  return ref.id;
}

export async function getScan(id: string): Promise<ScanDoc | null> {
  const snap = await scanRef(id).get();
  return snap.exists ? (snap.data() as ScanDoc) : null;
}

/**
 * Atomically claim a scan for running. Returns proceed:false (idempotent no-op)
 * if the doc is missing, already "running", or already "done" — so calling
 * /runScan twice for the same scanId never double-runs or double-writes.
 */
export async function claimScanForRun(id: string): Promise<{ proceed: boolean; reason?: string }> {
  return getDb().runTransaction(async (tx) => {
    const snap = await tx.get(scanRef(id));
    if (!snap.exists) return { proceed: false, reason: 'not-found' };
    const status = (snap.data() as ScanDoc).status;
    if (status === 'running') return { proceed: false, reason: 'already-running' };
    if (status === 'done') return { proceed: false, reason: 'already-done' };
    tx.set(scanRef(id), { status: 'running', startedAt: nowIso() }, { merge: true });
    return { proceed: true };
  });
}

export async function setStatus(
  id: string,
  status: ScanStatus,
  extra: Partial<ScanDoc> = {},
): Promise<void> {
  await scanRef(id).set({ status, ...extra }, { merge: true });
}

export async function updateProgress(id: string, progress: ScanProgress): Promise<void> {
  await scanRef(id).set({ progress }, { merge: true });
}

/**
 * Write a finding, SPLITTING the paid content out of the client-readable doc:
 *   scans/{id}/findings/{fid}          → public fields (no fix / fixPrompt)
 *   scans/{id}/findings/{fid}/private/fix → { fix, fixPrompt } (server-only)
 *
 * firestore.rules denies clients the `private` subcollection, so the free
 * (unauthenticated) client literally cannot read the fix — it's locked at the
 * data layer, not merely hidden in the UI. The id is the engine's deterministic
 * hash, so retries overwrite rather than duplicate.
 */
export async function writeFinding(scanId: string, finding: Finding): Promise<void> {
  const { fix, fixPrompt, ...pub } = finding;
  const fid = engineFindingId(finding);
  const docRef = findingsRef(scanId).doc(fid);
  await docRef.set(pub);
  if (fix !== undefined || fixPrompt !== undefined) {
    await docRef.collection('private').doc('fix').set({ fix, fixPrompt });
  }
}

/** Admin-only read of the locked fix content (used by the worker/tests, never a client). */
export async function readPrivateFix(
  scanId: string,
  findingId: string,
): Promise<{ fix?: string; fixPrompt?: string } | null> {
  const snap = await findingsRef(scanId).doc(findingId).collection('private').doc('fix').get();
  return snap.exists ? (snap.data() as { fix?: string; fixPrompt?: string }) : null;
}

export async function countFindings(scanId: string): Promise<number> {
  const snap = await findingsRef(scanId).count().get();
  return snap.data().count;
}

/** Public finding fields (fix/fixPrompt live in the private subcollection). */
export type PublicFinding = Omit<Finding, 'fix' | 'fixPrompt'>;

export async function listFindings(scanId: string): Promise<PublicFinding[]> {
  const snap = await findingsRef(scanId).get();
  return snap.docs.map((d) => d.data() as PublicFinding);
}

export const startedFields = () => ({ startedAt: nowIso() });
export const finishedFields = () => ({ finishedAt: nowIso() });

/* -------------------------------------------------------------------------- */
/* Users                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Idempotently create `users/{uid}` on first sign-in. Never overwrites an
 * existing doc (so `plan` set later by billing is preserved). Runs server-side
 * (Admin), so the client can never forge the initial plan.
 */
export async function ensureUser(info: { uid: string; email?: string; name?: string; provider?: string }): Promise<UserDoc> {
  const ref = userRef(info.uid);
  return getDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return snap.data() as UserDoc;
    const doc: UserDoc = {
      uid: info.uid,
      email: info.email,
      displayName: info.name,
      createdAt: nowIso(),
      plan: 'free',
      provider: info.provider,
      connections: {},
      alertEmail: info.email,
    };
    tx.set(ref, doc);
    return doc;
  });
}

export async function getUser(uid: string): Promise<UserDoc | null> {
  const snap = await userRef(uid).get();
  return snap.exists ? (snap.data() as UserDoc) : null;
}

/** Server-side plan lookup. Ready for Slice 6 to gate fixes on. Defaults 'free'. */
export async function getPlan(uid: string): Promise<UserDoc['plan']> {
  const u = await getUser(uid);
  return u?.plan ?? 'free';
}

/* -------------------------------------------------------------------------- */
/* Claim an anonymous scan                                                     */
/* -------------------------------------------------------------------------- */

export type ClaimResult = { ok: true } | { ok: false; status: number; error: string };

/** Assign ownerUid to a currently-ownerless scan. Idempotent-safe, race-safe. */
export async function claimScan(scanId: string, uid: string): Promise<ClaimResult> {
  return getDb().runTransaction(async (tx) => {
    const snap = await tx.get(scanRef(scanId));
    if (!snap.exists) return { ok: false as const, status: 404, error: 'scan not found' };
    const owner = (snap.data() as ScanDoc).ownerUid ?? null;
    if (owner !== null) {
      // Already owned. If it's already yours, treat as success (idempotent).
      return owner === uid ? { ok: true as const } : { ok: false as const, status: 409, error: 'scan already claimed' };
    }
    tx.set(scanRef(scanId), { ownerUid: uid }, { merge: true });
    return { ok: true as const };
  });
}

/** Admin listing of a user's scans (tests / server use; clients query directly). */
export async function listUserScans(uid: string): Promise<ScanDoc[]> {
  const snap = await getDb().collection('scans').where('ownerUid', '==', uid).orderBy('createdAt', 'desc').get();
  return snap.docs.map((d) => d.data() as ScanDoc);
}
