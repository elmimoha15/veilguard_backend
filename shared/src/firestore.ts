import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue, type Firestore } from 'firebase-admin/firestore';
import { findingId as engineFindingId } from 'veilguard-scanner';
import { config } from './config.js';
import { makeStaging } from './staging.js';
import type { Finding, Provider, ScanDoc, ScanProgress, ScanStatus, Target, UserDoc } from './types.js';

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
export async function createScanDoc(
  target: Target,
  ownerUid: string | null = null,
  extra: Partial<Pick<ScanDoc, 'origin' | 'appId'>> = {},
): Promise<string> {
  const ref = getDb().collection('scans').doc();
  const doc: ScanDoc = {
    id: ref.id,
    target,
    type: 'url',
    ownerUid,
    status: 'queued',
    createdAt: nowIso(),
    ...extra,
  };
  await ref.set(doc);
  return ref.id;
}

export async function getScan(id: string): Promise<ScanDoc | null> {
  const snap = await scanRef(id).get();
  return snap.exists ? (snap.data() as ScanDoc) : null;
}

/** Create a deep (white-box, connected) scan doc owned by uid. */
export async function createDeepScanDoc(
  uid: string,
  sources: { github?: boolean; githubRepo?: string; supabase?: boolean; url?: string },
  extra: Partial<Pick<ScanDoc, 'origin' | 'appId'>> = {},
): Promise<string> {
  const ref = getDb().collection('scans').doc();
  // Prefer the chosen repo name as the label so each repo is a distinct "site".
  const label = sources.githubRepo
    ? sources.githubRepo
    : sources.github
      ? 'github'
      : sources.supabase
        ? 'supabase'
        : (sources.url ?? 'deep');
  const doc: ScanDoc = {
    id: ref.id,
    target: { type: 'repo', value: `connected:${label}` },
    type: 'deep',
    sources,
    ownerUid: uid,
    status: 'queued',
    createdAt: nowIso(),
    ...extra,
  };
  await ref.set(doc);
  return ref.id;
}

/**
 * Create an upload (white-box, Pro-only) scan doc owned by uid. The uploaded
 * source has already been staged (see StagingStore); the worker extracts it into
 * an ephemeral workspace and wipes it after the scan — nothing is persisted here.
 */
export async function createUploadScanDoc(
  uid: string,
  info: { name: string },
  extra: Partial<Pick<ScanDoc, 'origin' | 'appId'>> = {},
): Promise<string> {
  const ref = getDb().collection('scans').doc();
  const doc: ScanDoc = {
    id: ref.id,
    target: { type: 'repo', value: `upload:${info.name}` },
    type: 'upload',
    sources: { upload: true },
    ownerUid: uid,
    status: 'queued',
    createdAt: nowIso(),
    ...extra,
  };
  await ref.set(doc);
  return ref.id;
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

/** Admin-only read of the locked fix content (used by the worker/tests, never a client).
 *  `ai:true` marks a Claude-tailored fix (vs the engine's canned one). */
export async function readPrivateFix(
  scanId: string,
  findingId: string,
): Promise<{ fix?: string; fixPrompt?: string; explanation?: string; ai?: boolean } | null> {
  const snap = await findingsRef(scanId).doc(findingId).collection('private').doc('fix').get();
  return snap.exists ? (snap.data() as { fix?: string; fixPrompt?: string; explanation?: string; ai?: boolean }) : null;
}

/** Admin read of ONE public finding (by its doc id) — for on-demand fix generation. */
export async function getPublicFinding(scanId: string, findingId: string): Promise<PublicFinding | null> {
  const snap = await findingsRef(scanId).doc(findingId).get();
  return snap.exists ? (snap.data() as PublicFinding) : null;
}

/** Store a Claude fix on a finding BY its known doc id (on-demand path; no engine id recompute). */
export async function writeAiFixById(
  scanId: string,
  findingId: string,
  fix: { fix: string; fixPrompt: string; explanation: string },
): Promise<void> {
  await findingsRef(scanId).doc(findingId).collection('private').doc('fix').set({ ...fix, ai: true }, { merge: true });
}

/**
 * Overwrite a finding's private/fix with a Claude-tailored fix (Slice 8). Keyed
 * by the same deterministic finding id, so it replaces the canned fix written by
 * writeFinding. `explanation` is the plain-English risk summary (Claude only).
 */
export async function writeAiFix(
  scanId: string,
  finding: Finding,
  fix: { fix: string; fixPrompt: string; explanation: string },
): Promise<void> {
  const fid = engineFindingId(finding);
  await findingsRef(scanId).doc(fid).collection('private').doc('fix').set({ ...fix, ai: true }, { merge: true });
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

/** Public findings WITH their doc ids (the id is needed to gate fixes via canReadFix). */
export async function listFindingDocs(scanId: string): Promise<{ id: string; finding: PublicFinding }[]> {
  const snap = await findingsRef(scanId).get();
  return snap.docs.map((d) => ({ id: d.id, finding: d.data() as PublicFinding }));
}

const SEV_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

/**
 * The single free "teaser" finding for a scan: the highest-severity finding
 * (tie-broken by doc id) that actually has a fix. Deterministic + server-side —
 * free users may read this one fix via /findingFix; every other finding is 402.
 * Returns null for a scan with no findings.
 */
export async function getTeaserFindingId(scanId: string): Promise<string | null> {
  const snap = await findingsRef(scanId).get();
  if (snap.empty) return null;
  const sorted = snap.docs
    .map((d) => ({ id: d.id, sev: String((d.data() as { severity?: string }).severity ?? 'info') }))
    .sort((a, b) => (SEV_RANK[b.sev] ?? 0) - (SEV_RANK[a.sev] ?? 0) || a.id.localeCompare(b.id));
  for (const f of sorted) {
    const fix = await readPrivateFix(scanId, f.id);
    if (fix && (fix.fix || fix.fixPrompt)) return f.id;
  }
  return sorted[0]?.id ?? null; // no fixes at all — top finding (endpoint will 404 the fix)
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
export async function ensureUser(info: { uid: string; email?: string; name?: string; provider?: string }): Promise<{ user: UserDoc; created: boolean }> {
  const ref = userRef(info.uid);
  return getDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return { user: snap.data() as UserDoc, created: false };
    const doc: UserDoc = {
      uid: info.uid,
      email: info.email,
      displayName: info.name,
      createdAt: nowIso(),
      plan: 'free',
      provider: info.provider,
      connections: {},
      alertEmail: info.email,
      onboarded: false,
    };
    tx.set(ref, doc);
    return { user: doc, created: true };
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

/**
 * Server-side plan setter (Admin only — firestore.rules forbid clients changing
 * `plan`). Called by the fake-billing endpoint today and by the real Polar
 * webhook later; both are the ONLY authorities that can grant a paid plan.
 */
export async function setPlan(uid: string, plan: UserDoc['plan']): Promise<void> {
  await userRef(uid).set({ plan }, { merge: true });
}

/**
 * Server-only billing writer (Polar webhook). Merges plan + subscription fields
 * onto the user doc. `undefined` fields are ignored (ignoreUndefinedProperties),
 * so callers pass only what changed.
 */
export async function setBilling(
  uid: string,
  patch: Partial<Pick<UserDoc, 'plan' | 'status' | 'subscriptionId' | 'polarCustomerId' | 'currentPeriodEnd' | 'cancelAtPeriodEnd'>>,
): Promise<void> {
  await userRef(uid).set(patch, { merge: true });
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

/* -------------------------------------------------------------------------- */
/* Connections (Slice 5)                                                       */
/*                                                                             */
/* Non-secret metadata lives (client-readable) at users/{uid}.connections.     */
/* Encrypted credentials live ONLY at secrets/{uid} — denied to all clients by */
/* firestore.rules and never returned to a client.                            */
/* -------------------------------------------------------------------------- */

const secretRef = (uid: string) => getDb().collection('secrets').doc(uid);

/** Store an encrypted credential + client-readable metadata for a provider. */
export async function setConnection(
  uid: string,
  provider: Provider,
  meta: Record<string, unknown>,
  encryptedSecret: string,
): Promise<void> {
  await secretRef(uid).set({ [provider]: encryptedSecret }, { merge: true });
  await userRef(uid).set({ connections: { [provider]: { ...meta, connectedAt: nowIso() } } }, { merge: true });
}

/** Read + return the ENCRYPTED credential blob (server-only). Null if absent. */
export async function getEncryptedSecret(uid: string, provider: Provider): Promise<string | null> {
  const snap = await secretRef(uid).get();
  const v = snap.exists ? (snap.data() as Record<string, unknown>)[provider] : undefined;
  return typeof v === 'string' ? v : null;
}

/** Replace just the encrypted credential blob (e.g. after a token refresh). */
export async function updateEncryptedSecret(uid: string, provider: Provider, encryptedSecret: string): Promise<void> {
  await secretRef(uid).set({ [provider]: encryptedSecret }, { merge: true });
}

/** Merge a patch into a provider's client-readable connection metadata. */
export async function patchConnectionMeta(uid: string, provider: Provider, patch: Record<string, unknown>): Promise<void> {
  await userRef(uid).set({ connections: { [provider]: patch } }, { merge: true });
}

export async function getConnectionMeta(uid: string, provider: Provider): Promise<Record<string, unknown> | null> {
  const u = await getUser(uid);
  const conns = (u as unknown as { connections?: Record<string, Record<string, unknown>> })?.connections;
  return conns?.[provider] ?? null;
}

export async function hasConnection(uid: string, provider: Provider): Promise<boolean> {
  return (await getEncryptedSecret(uid, provider)) !== null;
}

/** Revoke: delete the encrypted credential AND the metadata. */
export async function deleteConnection(uid: string, provider: Provider): Promise<void> {
  await secretRef(uid).set({ [provider]: FieldValue.delete() }, { merge: true });
  await userRef(uid).set({ connections: { [provider]: FieldValue.delete() } }, { merge: true });
}

/* -------------------------------------------------------------------------- */
/* OAuth state (CSRF) — server-only. Lives in `oauthStates/{state}`, which the  */
/* default firestore.rules DENY to every client. Maps a short-lived random      */
/* state → the uid that started the flow, so the callback can't be forged.      */
/* -------------------------------------------------------------------------- */
export interface OAuthState { uid: string; provider: string; createdAt: string; codeVerifier?: string }

export async function setOAuthState(state: string, data: OAuthState): Promise<void> {
  await getDb().collection('oauthStates').doc(state).set(data);
}

/** Read the state and delete it (single-use). Null if unknown. */
export async function consumeOAuthState(state: string): Promise<OAuthState | null> {
  const ref = getDb().collection('oauthStates').doc(state);
  const snap = await ref.get();
  if (!snap.exists) return null;
  await ref.delete();
  return snap.data() as OAuthState;
}

/* -------------------------------------------------------------------------- */
/* Account deletion — purge EVERY Firestore store keyed to a user (Admin only) */
/* -------------------------------------------------------------------------- */

/** Delete all docs a query returns, via a BulkWriter (batched, resilient). */
async function deleteQuery(query: FirebaseFirestore.Query): Promise<number> {
  const snap = await query.get();
  if (snap.empty) return 0;
  const writer = getDb().bulkWriter();
  for (const doc of snap.docs) void writer.delete(doc.ref);
  await writer.close();
  return snap.size;
}

/**
 * Permanently delete everything in Firestore tied to `uid`:
 * owned scans (+ their findings and the private fix subtrees, via
 * recursiveDelete), monitor events + run state, encrypted secrets, the user doc
 * itself (which also drops embedded `apps[]`, `connections`, and the plan), and
 * any dangling OAuth state. Best-effort per store — logs and continues so one
 * failure can't strand the rest. Upstream token revocation and Firebase Auth
 * deletion are handled by the caller (they need crypto/auth deps).
 *
 * Returns a small summary for logging/tests.
 */
export async function purgeUserFirestore(uid: string): Promise<{ scans: number; monitorEvents: number; monitorRuns: number }> {
  const db = getDb();

  // 1) Owned scans + their subcollections (findings + private/fix). A plain doc
  //    delete would orphan the subcollections, so recursiveDelete each. Clear any
  //    lingering staged upload zip too (normally deleted by the worker already).
  const scans = await listUserScans(uid);
  const staging = makeStaging();
  for (const s of scans) {
    if (s.type === 'upload') { try { await staging.delete(s.id); } catch (e) { console.error(`[deleteAccount] staging ${s.id}:`, e); } }
    try { await db.recursiveDelete(scanRef(s.id)); } catch (e) { console.error(`[deleteAccount] scan ${s.id}:`, e); }
  }

  // 2) Monitor events + 3) run state (both top-level, carry a `uid` field).
  let monitorEvents = 0, monitorRuns = 0;
  try { monitorEvents = await deleteQuery(db.collection('monitorEvents').where('uid', '==', uid)); } catch (e) { console.error('[deleteAccount] monitorEvents:', e); }
  try { monitorRuns = await deleteQuery(db.collection('monitorRuns').where('uid', '==', uid)); } catch (e) { console.error('[deleteAccount] monitorRuns:', e); }

  // 4) Encrypted secrets (GitHub installation id / Supabase tokens).
  try { await secretRef(uid).delete(); } catch (e) { console.error('[deleteAccount] secrets:', e); }

  // 5) The user doc — drops profile + embedded apps[] + connections + plan.
  try { await userRef(uid).delete(); } catch (e) { console.error('[deleteAccount] user:', e); }

  // 6) Any dangling single-use OAuth CSRF state for this user.
  try { await deleteQuery(db.collection('oauthStates').where('uid', '==', uid)); } catch (e) { console.error('[deleteAccount] oauthStates:', e); }

  return { scans: scans.length, monitorEvents, monitorRuns };
}

/** Bare, normalized host (mirrors the frontend `hostOf` / groupApps grouping). */
function hostOfValue(value: string | undefined): string {
  if (!value) return '';
  try {
    return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return value.trim().toLowerCase();
  }
}

/** Identity of a single app to purge: any of these that are set are matched. */
export interface AppTarget { appId?: string; githubRepo?: string; url?: string }

/** Does this scan belong to the given app? Mirrors the frontend grouping. */
function scanBelongsToApp(s: ScanDoc, t: AppTarget): boolean {
  const repo = t.githubRepo?.toLowerCase();
  if (t.appId && s.appId === t.appId) return true;
  if (repo && s.type === 'deep' && s.sources?.githubRepo?.toLowerCase() === repo) return true;
  if (t.url && s.type === 'url' && hostOfValue(s.target.value) === hostOfValue(t.url)) return true;
  return false;
}

/**
 * Permanently delete everything in Firestore tied to ONE app owned by `uid`:
 * every matching scan (+ its findings and private/fix subtrees, via
 * recursiveDelete, plus any staged upload), the monitoring run-state doc, all
 * monitoring events for the app, and the app's entry in the client-owned
 * `users/{uid}.apps[]` registry (which also drops its monitoring config).
 *
 * Account-level data is deliberately LEFT INTACT: the provider connections
 * (`secrets/{uid}`, `users/{uid}.connections`) are shared across all of the
 * user's apps, and the user's plan is untouched. Best-effort per store.
 *
 * `target` must carry at least one of appId / githubRepo / url. All reads are
 * scoped to `uid`, so a caller can only ever purge its own app.
 */
export async function purgeAppFirestore(
  uid: string,
  target: AppTarget,
): Promise<{ scans: number; monitorEvents: number; monitorRuns: number; registryRemoved: boolean }> {
  const db = getDb();

  // 1) Matching scans + their subcollections (findings + private/fix).
  const all = await listUserScans(uid);
  const mine = all.filter((s) => scanBelongsToApp(s, target));
  const staging = makeStaging();
  for (const s of mine) {
    if (s.type === 'upload') { try { await staging.delete(s.id); } catch (e) { console.error(`[deleteApp] staging ${s.id}:`, e); } }
    try { await db.recursiveDelete(scanRef(s.id)); } catch (e) { console.error(`[deleteApp] scan ${s.id}:`, e); }
  }

  // 2) Monitoring run-state + 3) events — keyed by appId (registry apps only).
  let monitorEvents = 0, monitorRuns = 0;
  if (target.appId) {
    try { await db.collection('monitorRuns').doc(`${uid}__${target.appId}`).delete(); monitorRuns = 1; } catch (e) { console.error('[deleteApp] monitorRuns:', e); }
    try { monitorEvents = await deleteQuery(db.collection('monitorEvents').where('uid', '==', uid).where('appId', '==', target.appId)); } catch (e) { console.error('[deleteApp] monitorEvents:', e); }
  }

  // 4) Remove the app from the client-owned registry (drops its monitoring config).
  let registryRemoved = false;
  if (target.appId) {
    try {
      const user = await getUser(uid);
      const apps = ((user as unknown as { apps?: { id?: string }[] })?.apps) ?? [];
      if (Array.isArray(apps) && apps.some((a) => a?.id === target.appId)) {
        const next = apps.filter((a) => a?.id !== target.appId);
        await userRef(uid).set({ apps: next }, { merge: true });
        registryRemoved = true;
      }
    } catch (e) { console.error('[deleteApp] registry:', e); }
  }

  return { scans: mine.length, monitorEvents, monitorRuns, registryRemoved };
}
